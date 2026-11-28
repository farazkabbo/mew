//! Circle & Ask over a single privacy-checked, redacted window snapshot. The local card can
//! ask follow-ups about that snapshot until its original TTL or native generation expires.
use super::{
    annotate, capture,
    capture_session::{self, NativeFrame},
    clip, overlay,
    pipeline::Intent,
    runtime, service_call,
    target::{PixelRect, Rect},
};
use crate::screen::{
    circle_protocol::{
        self as wire, AskHead, BlockOut, CircleEvent, ContentKind, Jpeg, MarkOut, Question,
        SourceOut, Turn,
    },
    circle_steps::{Cue, Playback, Voice},
    destination::{self, Place, Resolution},
    frame::ScreenRect,
    image,
    ink::DrawnInk,
    marks::{self, MarkKind, Pt},
    protocol::{Box2, EntryHead, EntryTurnOut, LineSplitter, ScreenAction},
    surfaces::Surface,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{ipc::CapabilityBuilder, AppHandle, Manager, WebviewWindow};
#[derive(Default)]
struct Host {
    serial: AtomicU64,
    session: Mutex<Option<Session>>,
}
struct Session {
    serial: u64,
    id: String,
    frame: Arc<NativeFrame>,
    retention: capture_session::CircleRetention,
    last_input: Instant,
    marking: bool,
    idle_hidden: bool,
    policy_checked: Instant,
    focus: PixelRect,
    marks: Vec<SelectionMark>,
    drawn_steps: std::collections::BTreeMap<usize, DrawnInk>,
    stamp: [u8; 32],
    history: Vec<Turn>,
    question: String,
    steps: Vec<wire::Step>,
    summary: String,
    follow_up: Option<String>,
    concepts: Vec<String>,
    playback: Playback,
    current: usize,
    paused: bool,
    paused_for_words: bool,
    done: bool,
    busy: bool,
    saving: bool,
    save_at: Option<Instant>,
    saved: bool,
    saved_entry: Option<clip::SavedEntry>,
    applied_destination: Option<Place>,
    destination_move: Arc<Mutex<()>>,
    aborted: bool,
    destination: Option<Place>,
    choices: Vec<Place>,
    create: Option<Place>,
}
#[derive(Clone)]
struct SelectionMark {
    kind: MarkKind,
    points: Vec<Pt>,
    region: ScreenRect,
    text: String,
    dashed: bool,
}
fn semantic_mark(
    text: &crate::screen::screen_text::ScreenText,
    points: Vec<Pt>,
    dashed: bool,
    scale: f32,
    rules: &crate::screen::privacy::detect::RedactionRules,
) -> Option<SelectionMark> {
    let kind = marks::classify(&points, scale);
    let words = text.word_boxes();
    let targets = marks::target_words(kind, &points, &words, scale);
    let mut region = marks::region(&points, &words, &targets)?;
    // A tap/flat underline still needs a positive focus crop when OCR found nothing nearby.
    if region.right <= region.left {
        region.right = region.left + 1;
    }
    if region.bottom <= region.top {
        region.bottom = region.top + 1;
    }
    Some(SelectionMark {
        kind,
        points,
        region,
        text: text.text_of(&targets, rules),
        dashed,
    })
}
fn push_mark(marks: &mut Vec<SelectionMark>, mark: SelectionMark) -> Result<(), String> {
    if marks.len() >= marks::MAX_MARKS {
        return Err(
            "Up to three marks at a time. Ask about these, or press Esc to start again.".into(),
        );
    }
    marks.push(mark);
    Ok(())
}
fn focus_bounds(focus: PixelRect) -> ScreenRect {
    ScreenRect {
        left: focus.left as i32,
        top: focus.top as i32,
        right: focus.right as i32,
        bottom: focus.bottom as i32,
    }
}
fn box_in(rect: ScreenRect, bounds: ScreenRect) -> Box2 {
    let a = marks::to_normalised((rect.left as f32, rect.top as f32), bounds);
    let b = marks::to_normalised((rect.right as f32, rect.bottom as f32), bounds);
    Box2 {
        left: a.x,
        top: a.y,
        right: b.x,
        bottom: b.y,
    }
}
fn marks_for_request(marks: &[SelectionMark], focus: PixelRect) -> Vec<MarkOut> {
    let bounds = focus_bounds(focus);
    marks
        .iter()
        .enumerate()
        .map(|(i, m)| MarkOut {
            number: (i + 1) as u8,
            kind: m.kind,
            region: box_in(m.region, bounds),
            polygon: marks::simplified(&m.points)
                .into_iter()
                .map(|p| marks::to_normalised(p, bounds))
                .collect(),
            text: m.text.clone(),
        })
        .collect()
}
fn focus_of(marks: &[SelectionMark], size: (u32, u32)) -> Option<PixelRect> {
    let r = crate::screen::screen_text::union(marks.iter().map(|m| m.region))?;
    // Include a small margin so an underline's glyphs and an arrow's endpoint remain visible.
    let left = (r.left - 8).max(0) as u32;
    let top = (r.top - 8).max(0) as u32;
    let right = (r.right + 8).max(1).min(size.0 as i32) as u32;
    let bottom = (r.bottom + 8).max(1).min(size.1 as i32) as u32;
    (left < right && top < bottom).then_some(PixelRect {
        left,
        top,
        right,
        bottom,
    })
}
fn combined_ink(
    steps: &std::collections::BTreeMap<usize, DrawnInk>,
    focus: PixelRect,
) -> (DrawnInk, Vec<u8>) {
    let mut ink = DrawnInk {
        id: 0,
        strokes: vec![],
        cards: vec![],
        bbox: Some([
            focus.left as f32,
            focus.top as f32,
            (focus.right - focus.left) as f32,
            (focus.bottom - focus.top) as f32,
        ]),
        step: None,
    };
    let mut indexes = vec![];
    for (index, step) in steps {
        ink.strokes.extend(step.strokes.clone());
        indexes.extend(std::iter::repeat_n(*index as u8, step.strokes.len()));
        ink.cards.extend(step.cards.clone());
        if let Some(b) = step.bbox {
            if let Some(a) = ink.bbox {
                let l = a[0].min(b[0]);
                let t = a[1].min(b[1]);
                ink.bbox = Some([
                    l,
                    t,
                    (a[0] + a[2]).max(b[0] + b[2]) - l,
                    (a[1] + a[3]).max(b[1] + b[3]) - t,
                ]);
            }
        }
    }
    (ink, indexes)
}
fn student_strokes(marks: &[SelectionMark]) -> Vec<crate::screen::protocol::ClipStroke> {
    marks
        .iter()
        .map(|m| crate::screen::protocol::ClipStroke {
            tool: "pen",
            color: crate::screen::ink::STUDENT_INK.into(),
            width: 3.,
            points: m
                .points
                .iter()
                .enumerate()
                .map(|(i, p)| [p.0, p.1, 0.5, i as f32])
                .collect(),
        })
        .collect()
}
/// Called only after the native ink host validates its exact pending acknowledgment. A unique
/// immutable seed binds the result to its Circle session and explanation step.
pub fn record_drawn(
    app: &AppHandle,
    target: &super::pipeline::Target,
    generation: u64,
    seed: &str,
    ink: DrawnInk,
) {
    let mut parts = seed.split(':');
    if parts.next() != Some("circle") {
        return;
    }
    let Some(serial) = parts.next().and_then(|p| p.parse::<u64>().ok()) else {
        return;
    };
    let Some(index) = parts.next().and_then(|p| p.parse::<usize>().ok()) else {
        return;
    };
    if parts.next().is_some() {
        return;
    }
    let Ok(h) = state(app) else {
        return;
    };
    let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(s) = slot.as_mut().filter(|s| {
        s.serial == serial
            && s.frame.target == *target
            && s.frame.generation == generation
            && valid(app, s)
            && index < s.steps.len()
    }) {
        s.drawn_steps.insert(index, ink);
    }
}
pub fn stored_target_current_main(app: &AppHandle) -> bool {
    let Ok(h) = state(app) else {
        return false;
    };
    let frame = h
        .session
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .filter(|s| valid(app, s))
        .map(|s| s.frame.clone());
    frame.is_some_and(|f| capture_session::stored_target_current_main(app, &f.target, f.generation))
}
fn state(app: &AppHandle) -> Result<tauri::State<'_, Host>, String> {
    app.try_state()
        .ok_or_else(|| "Circle & Ask is not ready.".into())
}
fn valid(app: &AppHandle, s: &Session) -> bool {
    let Ok(r) = runtime::of(app) else {
        return false;
    };
    let (c, reset) = r.snapshot();
    s.retention.grant().live()
        && !reset
        && c.is_on()
        && !c.paused
        && c.privacy.show_in_captures
        && r.generation.load(Ordering::Acquire) == s.frame.generation
        && state(app).is_ok_and(|h| h.serial.load(Ordering::Acquire) == s.serial)
}
#[derive(Debug, PartialEq, Eq)]
enum IdleAction {
    Keep,
    Hide,
    Close,
}
fn idle_action(marking: bool, drawing: bool, idle: Duration) -> IdleAction {
    if !marking || drawing {
        IdleAction::Keep
    } else if idle >= Duration::from_secs(80) {
        IdleAction::Close
    } else if idle >= Duration::from_secs(20) {
        IdleAction::Hide
    } else {
        IdleAction::Keep
    }
}
pub fn setup(app: &AppHandle) -> Result<(), String> {
    app.manage(Host::default());
    app.add_capability(
        CapabilityBuilder::new("mac-circle-card")
            .local(true)
            .window(Surface::Card.label())
            .permission("allow-screen-circle-ready")
            .permission("allow-screen-circle-card"),
    )
    .map_err(|_| "Couldn't configure Circle & Ask.".to_owned())?;
    let app = app.clone();
    std::thread::Builder::new()
        .name("neb-circle-playback".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(100));
            let Ok(h) = state(&app) else {
                continue;
            };
            // Never hold the session lock across AppKit, Keychain or source-policy reads.
            let voice_pending = super::ask::voice_pending(&app);
            let drawing =
                super::drawing::view(&app).0 != crate::screen::island::Tool::None || voice_pending;
            let (idle, policy) = {
                let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
                let Some(session) = slot.as_mut() else {
                    continue;
                };
                let idle = match idle_action(session.marking, drawing, session.last_input.elapsed())
                {
                    IdleAction::Hide if !session.idle_hidden => {
                        session.idle_hidden = true;
                        Some((session.serial, false))
                    }
                    IdleAction::Close => Some((session.serial, true)),
                    _ => None,
                };
                let policy = if !voice_pending
                    && session.policy_checked.elapsed() >= Duration::from_millis(500)
                {
                    session.policy_checked = Instant::now();
                    Some((
                        session.frame.clone(),
                        session.retention.grant(),
                        session.serial,
                    ))
                } else {
                    None
                };
                (idle, policy)
            };
            if let Some((serial, close)) = idle {
                if close {
                    revoke_if_serial(&app, serial);
                    continue;
                }
                hide_for(&app, serial);
            }
            if let Some((frame, grant, serial)) = policy {
                if !capture_session::retained_current(&app, &frame, &grant) {
                    revoke_if_serial(&app, serial);
                    continue;
                }
            }
            let (cues, expired, serial) = {
                let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
                if slot.as_ref().is_some_and(|s| !valid(&app, s)) {
                    slot.take();
                    (vec![], true, 0)
                } else {
                    let (cues, serial) = slot
                        .as_mut()
                        .map(|s| (s.playback.tick(Instant::now()), s.serial))
                        .unwrap_or_default();
                    (cues, false, serial)
                }
            };
            if expired {
                hide(&app);
            } else {
                run_cues(&app, cues, serial);
                let auto = h
                    .session
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .as_ref()
                    .filter(|s| {
                        !s.busy && !s.saved && s.save_at.is_some_and(|at| Instant::now() >= at)
                    })
                    .map(|s| ActionTicket {
                        serial: s.serial,
                        generation: s.frame.generation,
                        stamp: s.stamp,
                    });
                if let Some(ticket) = auto {
                    let _ = save_session_for(&app, false, false, false, ticket);
                }
            }
        })
        .map_err(|_| "Couldn't start Circle & Ask playback.".to_owned())?;
    Ok(())
}
fn hide(app: &AppHandle) {
    hide_for(app, epoch(app));
}
fn hide_for(app: &AppHandle, serial: u64) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if epoch(&handle) != serial {
            return;
        }
        if let Some(w) = handle.get_webview_window(Surface::Card.label()) {
            let _ = overlay::hide(&w);
        }
        let _ = annotate::clear(&handle);
        crate::screen::page::dispatch(&handle, crate::screen::page::HUSH, json!({}));
    });
}
pub fn cancel_all(app: &AppHandle) {
    if let Ok(h) = state(app) {
        let serial = {
            let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
            let serial = h.serial.fetch_add(1, Ordering::AcqRel) + 1;
            slot.take();
            serial
        };
        hide_for(app, serial);
    }
}
pub fn epoch(app: &AppHandle) -> u64 {
    state(app)
        .map(|h| h.serial.load(Ordering::Acquire))
        .unwrap_or(0)
}
/// Worker entry from the drawing surface. Rectangle is global Quartz points.
pub fn select(app: &AppHandle, region: Rect) -> Result<(), String> {
    select_inner(app, region, None)
}

pub fn select_bound(
    app: &AppHandle,
    region: Rect,
    expected: super::pipeline::Target,
) -> Result<(), String> {
    select_inner(app, region, Some(expected))
}

fn select_inner(
    app: &AppHandle,
    region: Rect,
    expected: Option<super::pipeline::Target>,
) -> Result<(), String> {
    let points = vec![
        (region.x as f32, region.y as f32),
        ((region.x + region.width) as f32, region.y as f32),
        (
            (region.x + region.width) as f32,
            (region.y + region.height) as f32,
        ),
        (region.x as f32, (region.y + region.height) as f32),
        (region.x as f32, region.y as f32),
    ];
    mark_bound(app, points, true, expected).map(|_| ())
}
/// Capture before any keyboard panel is activated. Reuses only the exact native target/session.
pub fn prepare(app: &AppHandle, expected: Option<super::pipeline::Target>) -> Result<u64, String> {
    let generation = runtime::of(app)?.generation.load(Ordering::Acquire);
    prepare_at(app, expected, generation)
}
pub fn prepare_at(
    app: &AppHandle,
    expected: Option<super::pipeline::Target>,
    generation: u64,
) -> Result<u64, String> {
    prepare_checked(app, expected, generation, epoch(app), &|| true)
}
fn while_current<T>(
    current: &dyn Fn() -> bool,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if !current() {
        return Err("The selection was cancelled.".into());
    }
    operation()
}
pub fn prepare_checked(
    app: &AppHandle,
    expected: Option<super::pipeline::Target>,
    generation: u64,
    origin_epoch: u64,
    active: &dyn Fn() -> bool,
) -> Result<u64, String> {
    if !active()
        || epoch(app) != origin_epoch
        || runtime::of(app)?.generation.load(Ordering::Acquire) != generation
    {
        return Err("The selection was cancelled.".into());
    }
    let existing = state(app)?
        .session
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .filter(|s| valid(app, s))
        .map(|s| (s.frame.clone(), s.serial));
    if let Some((frame, serial)) = existing {
        if expected.as_ref().is_none_or(|e| *e == frame.target) && current_retained(app, &frame) {
            if !active() || epoch(app) != origin_epoch {
                return Err("The selection was cancelled.".into());
            }
            return Ok(serial);
        }
    }
    let h = state(app)?;
    let serial = {
        let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
        if !active()
            || h.serial.load(Ordering::Acquire) != origin_epoch
            || runtime::of(app)?.generation.load(Ordering::Acquire) != generation
        {
            return Err("The selection was cancelled.".into());
        }
        slot.take();
        h.serial.fetch_add(1, Ordering::AcqRel) + 1
    };
    if !active() {
        return Err("The selection was cancelled.".into());
    }
    hide_for(app, serial);
    let frame = while_current(
        &|| active() && h.serial.load(Ordering::Acquire) == serial,
        || capture_session::capture_window(app, Intent::Circle, generation),
    )?;
    if expected
        .as_ref()
        .is_some_and(|expected| *expected != frame.target)
    {
        return Err("The selection's window changed. Select it again.".into());
    }
    let (width, height) = frame.captured.metadata.captured_pixels;
    let focus = PixelRect {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    };
    let stamp = service_call::credential_stamp(app).map_err(|e| e.to_string())?;
    if !active()
        || !capture_session::is_current(app, &frame)
        || h.serial.load(Ordering::Acquire) != serial
    {
        return Err("The selection was cancelled.".into());
    }
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(|_| "Couldn't start Circle & Ask.")?;
    let id = uuid::Builder::from_random_bytes(random)
        .into_uuid()
        .to_string();
    let silent = runtime::of(app)?.snapshot().0.circle.silent;
    let frame = Arc::new(frame);
    let retention = capture_session::retain_circle(app, frame.clone(), stamp)?;
    let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
    if !active()
        || h.serial.load(Ordering::Acquire) != serial
        || runtime::of(app)?.generation.load(Ordering::Acquire) != generation
    {
        return Err("The selection was cancelled.".into());
    }
    *slot = Some(Session {
        serial,
        id,
        frame,
        retention,
        last_input: Instant::now(),
        marking: true,
        idle_hidden: false,
        policy_checked: Instant::now(),
        focus,
        marks: vec![],
        drawn_steps: Default::default(),
        stamp,
        history: vec![],
        question: String::new(),
        steps: vec![],
        summary: String::new(),
        follow_up: None,
        concepts: vec![],
        playback: Playback::new(
            if silent {
                Voice::Captions
            } else {
                Voice::Spoken
            },
            true,
        ),
        current: 0,
        paused: false,
        paused_for_words: false,
        done: false,
        busy: false,
        saving: false,
        save_at: None,
        saved: false,
        saved_entry: None,
        applied_destination: None,
        destination_move: Arc::new(Mutex::new(())),
        aborted: false,
        destination: None,
        choices: vec![],
        create: None,
    });
    Ok(serial)
}

pub fn mark_bound(
    app: &AppHandle,
    points: Vec<Pt>,
    dashed: bool,
    expected: Option<super::pipeline::Target>,
) -> Result<u64, String> {
    let generation = runtime::of(app)?.generation.load(Ordering::Acquire);
    mark_bound_at(app, points, dashed, expected, generation)
}
pub fn mark_bound_at(
    app: &AppHandle,
    points: Vec<Pt>,
    dashed: bool,
    expected: Option<super::pipeline::Target>,
    generation: u64,
) -> Result<u64, String> {
    mark_bound_checked(
        app,
        points,
        dashed,
        expected,
        generation,
        epoch(app),
        &|| true,
    )
}
pub fn mark_bound_checked(
    app: &AppHandle,
    points: Vec<Pt>,
    dashed: bool,
    expected: Option<super::pipeline::Target>,
    generation: u64,
    origin_epoch: u64,
    active: &dyn Fn() -> bool,
) -> Result<u64, String> {
    let prepared_serial = prepare_checked(app, expected, generation, origin_epoch, active)?;
    let h = state(app)?;
    let (frame, serial) = {
        let s = h.session.lock().unwrap_or_else(|p| p.into_inner());
        let s = s
            .as_ref()
            .filter(|s| s.serial == prepared_serial && active() && valid(app, s))
            .ok_or("The selection expired.")?;
        (s.frame.clone(), s.serial)
    };
    if !current_retained(app, &frame) {
        return Err("The drawing target changed.".into());
    }
    let b = frame.target.quartz_points;
    let size = frame.captured.metadata.captured_pixels;
    if points.is_empty()
        || points.len() > 4000
        || points.iter().any(|p| {
            !p.0.is_finite()
                || !p.1.is_finite()
                || !b.contains(super::target::Point {
                    x: f64::from(p.0),
                    y: f64::from(p.1),
                })
        })
    {
        return Err("Draw inside the captured foreground window.".into());
    }
    let points = points
        .into_iter()
        .map(|(x, y)| {
            (
                ((f64::from(x) - b.x) / b.width * f64::from(size.0)) as f32,
                ((f64::from(y) - b.y) / b.height * f64::from(size.1)) as f32,
            )
        })
        .collect();
    let rules = runtime::of(app)?.snapshot().0.privacy.redaction;
    let mark = semantic_mark(
        frame.text(),
        points,
        dashed,
        (f64::from(size.0) / b.width) as f32,
        &rules,
    )
    .ok_or("Couldn't understand that mark.")?;
    let serial = while_current(active, || {
        let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
        let s = slot
            .as_mut()
            .filter(|s| s.serial == serial && active() && valid(app, s))
            .ok_or("The selection expired.")?;
        push_mark(&mut s.marks, mark)?;
        s.focus = focus_of(&s.marks, size).ok_or("The mark is outside the window.")?;
        s.last_input = Instant::now();
        s.idle_hidden = false;
        s.marking = true;
        s.playback.stop();
        s.paused = false;
        s.save_at = None;
        s.busy = false;
        s.saving = false;
        s.serial = h.serial.fetch_add(1, Ordering::AcqRel) + 1;
        Ok(s.serial)
    })?;
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if !still(&handle, serial) {
            return;
        }
        let _ = annotate::clear(&handle);
        crate::screen::page::dispatch(&handle, crate::screen::page::HUSH, json!({}));
    });
    show_for(
        app,
        json!({"mode":"ask","silent":runtime::of(app)?.snapshot().0.circle.silent,"place":{}}),
        serial,
    );
    Ok(serial)
}
pub fn drawing_view(app: &AppHandle, display: Rect) -> (Value, Vec<[f32; 4]>) {
    let Ok(h) = state(app) else {
        return (json!([]), vec![]);
    };
    let slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
    let Some(s) = slot.as_ref().filter(|s| valid(app, s)) else {
        return (json!([]), vec![]);
    };
    let frame = &s.frame;
    let b = frame.target.quartz_points;
    let size = frame.captured.metadata.captured_pixels;
    let point = |(x, y): Pt| {
        [
            (b.x + f64::from(x) / f64::from(size.0) * b.width - display.x) as f32,
            (b.y + f64::from(y) / f64::from(size.1) * b.height - display.y) as f32,
        ]
    };
    let marks=s.marks.iter().enumerate().map(|(i,m)|json!({"number":i+1,"points":m.points.iter().copied().map(point).collect::<Vec<_>>(),"dashed":m.dashed})).collect::<Vec<_>>();
    let rules = runtime::of(app)
        .map(|r| r.snapshot().0.privacy.redaction)
        .unwrap_or_default();
    let mut blocks = frame
        .text()
        .blocks(&rules)
        .into_iter()
        .map(|block| super::drawing::block_points(block.rect, b, display, size))
        .collect::<Vec<_>>();
    if let Some(p) = super::input::cursor() {
        blocks.sort_by(|a, b| {
            let distance = |r: &[f32; 4]| {
                let x = f64::from(r[0] + r[2] / 2.) + display.x - p.x;
                let y = f64::from(r[1] + r[3] / 2.) + display.y - p.y;
                x * x + y * y
            };
            distance(a).total_cmp(&distance(b))
        });
    }
    blocks.truncate(40);
    (json!(marks), blocks)
}
fn selection_pixels(region: Rect, bounds: Rect, (width, height): (u32, u32)) -> Option<PixelRect> {
    Rect::new(region.x, region.y, region.width, region.height)?;
    if region.width < 8.
        || region.height < 8.
        || region.x < bounds.x
        || region.y < bounds.y
        || region.x + region.width > bounds.x + bounds.width
        || region.y + region.height > bounds.y + bounds.height
    {
        return None;
    }
    let l = ((region.x - bounds.x) / bounds.width * f64::from(width)).floor() as u32;
    let t = ((region.y - bounds.y) / bounds.height * f64::from(height)).floor() as u32;
    let r = ((region.x + region.width - bounds.x) / bounds.width * f64::from(width)).ceil() as u32;
    let b =
        ((region.y + region.height - bounds.y) / bounds.height * f64::from(height)).ceil() as u32;
    (l < r && t < b && r <= width && b <= height).then_some(PixelRect {
        left: l,
        top: t,
        right: r,
        bottom: b,
    })
}
fn show_for(app: &AppHandle, view: Value, serial: u64) {
    let Some((generation, stamp, action_session)) = state(app).ok().and_then(|h| {
        h.session.lock().ok().and_then(|s| {
            s.as_ref().filter(|s| s.serial == serial).map(|s| {
                (
                    s.frame.generation,
                    s.stamp,
                    format!("{}:{}", s.id, s.serial),
                )
            })
        })
    }) else {
        return;
    };
    let mut view = view;
    view["actionSession"] = Value::String(action_session);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let bounds = state(&handle).ok().and_then(|h| {
            h.session.lock().ok().and_then(|s| {
                s.as_ref()
                    .filter(|s| {
                        s.serial == serial
                            && s.frame.generation == generation
                            && s.stamp == stamp
                            && valid(&handle, s)
                    })
                    .filter(|_| service_call::credential_stamp(&handle).ok() == Some(stamp))
                    .map(|s| s.frame.target.quartz_points)
            })
        });
        if let Some(bounds) = bounds {
            if let Ok(w) = overlay::ensure(&handle, Surface::Card) {
                let x = bounds.x + (bounds.width - 440.).max(0.);
                let y = bounds.y + (bounds.height - 300.).max(0.);
                if let Some(rect) = Rect::new(x, y, 440., 300.) {
                    let _ = overlay::place(&w, rect);
                }
                let _ = overlay::show_quietly(&w);
                let _ = overlay::dispatch(&handle, Surface::Card, "mew:card-show", &view);
            }
        }
    });
}
fn place_view(s: &Session) -> Value {
    json!({"label":s.destination.as_ref().map(Place::label),"choices":s.choices.iter().map(Place::label).collect::<Vec<_>>(),"create":s.create.as_ref().and_then(|p|p.create.clone())})
}

#[tauri::command]
pub fn screen_circle_ready(window: WebviewWindow) -> Result<Value, String> {
    overlay::require_surface(&window, Surface::Card)?;
    let h = state(window.app_handle())?;
    let slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
    let s = slot
        .as_ref()
        .filter(|s| valid(window.app_handle(), s))
        .ok_or("The selection expired.")?;
    if let Some(step) = s.steps.get(s.current) {
        Ok(
            json!({"actionSession":format!("{}:{}",s.id,s.serial),"mode":"explain","step":s.current+1,"total":s.steps.len(),"say":step.say,"paused":s.paused,"place":place_view(s)}),
        )
    } else {
        Ok(
            json!({"actionSession":format!("{}:{}",s.id,s.serial),"mode":if s.busy { "thinking" } else { "ask" },"silent":runtime::of(window.app_handle())?.snapshot().0.circle.silent,"place":place_view(s)}),
        )
    }
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CardAction {
    Ask,
    SelectQuestion,
    Confirm,
    Pause,
    Resume,
    Repeat,
    Next,
    Stop,
    Undo,
    EditCrop,
    Open,
    Save,
    SaveOnly,
    ChangePlace,
    PickPlace,
    CreatePlace,
    PlaceCancel,
    Mic,
    Close,
    Fit,
}
#[path = "circle_action_ticket.rs"]
mod action_ticket;
use action_ticket::ActionTicket;
fn ticket_matches(app: &AppHandle, ticket: ActionTicket, s: &Session) -> bool {
    ticket.matches(s.serial, s.frame.generation, s.stamp) && valid(app, s)
}
fn action_ticket(app: &AppHandle) -> Result<ActionTicket, String> {
    let h = state(app)?;
    let slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
    let s = slot
        .as_ref()
        .filter(|s| valid(app, s))
        .ok_or("The screen selection expired.")?;
    Ok(ActionTicket {
        serial: s.serial,
        generation: s.frame.generation,
        stamp: s.stamp,
    })
}
fn action_ticket_from_display(
    app: &AppHandle,
    displayed: Option<&str>,
) -> Result<ActionTicket, String> {
    let h = state(app)?;
    let slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
    let s = slot
        .as_ref()
        .filter(|s| valid(app, s))
        .ok_or("The screen selection expired.")?;
    if !action_ticket::displayed_matches(displayed, &s.id, s.serial) {
        return Err("The displayed selection was replaced. Use the current card.".into());
    }
    Ok(ActionTicket {
        serial: s.serial,
        generation: s.frame.generation,
        stamp: s.stamp,
    })
}
fn ticket_current(app: &AppHandle, ticket: ActionTicket) -> bool {
    if service_call::credential_stamp(app).ok() != Some(ticket.stamp) {
        return false;
    }
    state(app).is_ok_and(|h| {
        h.session
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .is_some_and(|s| ticket_matches(app, ticket, s))
    })
}
fn close_for(app: &AppHandle, ticket: ActionTicket) {
    if let Ok(h) = state(app) {
        let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
        if !slot
            .as_ref()
            .is_some_and(|s| ticket_matches(app, ticket, s))
        {
            return;
        }
        let closed_serial = h.serial.fetch_add(1, Ordering::AcqRel) + 1;
        slot.take();
        drop(slot);
        hide_for(app, closed_serial);
    }
}
fn control_for(app: &AppHandle, ticket: ActionTicket, mic: bool) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if !ticket_current(&handle, ticket) {
            return;
        }
        if mic {
            let _ = super::ask::toggle_mic(&handle);
        } else {
            let _ = super::drawing::select_question(&handle);
        }
    })
    .map_err(|_| "Couldn't update Circle controls.".into())
}
fn snapshot_for(
    app: &AppHandle,
    ticket: ActionTicket,
) -> Result<(Arc<NativeFrame>, PixelRect, [u8; 32], u64), String> {
    if !ticket_current(app, ticket) {
        return Err("The screen selection expired.".into());
    }
    let (frame, focus, stamp, serial, grant) = {
        let h = state(app)?;
        let slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
        let s = slot
            .as_ref()
            .filter(|s| ticket_matches(app, ticket, s))
            .ok_or("The screen selection expired.")?;
        (
            s.frame.clone(),
            s.focus,
            s.stamp,
            s.serial,
            s.retention.grant(),
        )
    };
    if !capture_session::retained_current(app, &frame, &grant) {
        revoke_if_serial(app, serial);
        return Err("The Circle source or privacy settings changed.".into());
    }
    Ok((frame, focus, stamp, serial))
}
#[tauri::command]
pub async fn screen_circle_card(
    window: WebviewWindow,
    action: CardAction,
    text: Option<String>,
    action_session: Option<String>,
) -> Result<(), String> {
    overlay::require_surface(&window, Surface::Card)?;
    let app = window.app_handle().clone();
    let ticket = action_ticket_from_display(&app, action_session.as_deref())?;
    if action == CardAction::Close {
        close_for(&app, ticket);
        return Ok(());
    }
    if action == CardAction::Fit {
        return fit(&app, text.as_deref(), ticket);
    }
    tauri::async_runtime::spawn_blocking(move || perform(&app, action, text, ticket))
        .await
        .map_err(|_| "Circle & Ask stopped.".to_owned())?
}
fn perform(
    app: &AppHandle,
    action: CardAction,
    text: Option<String>,
    ticket: ActionTicket,
) -> Result<(), String> {
    if !ticket_current(app, ticket) {
        return Err("The screen selection expired.".into());
    }
    let h = state(app)?;
    let serial = ticket.serial;
    {
        let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(s) = slot.as_mut().filter(|s| ticket_matches(app, ticket, s)) {
            s.last_input = Instant::now();
            s.idle_hidden = false;
        }
    }
    match action {
        CardAction::Undo => {
            let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
            let s = slot
                .as_mut()
                .filter(|s| ticket_matches(app, ticket, s))
                .ok_or("Selection expired.")?;
            s.save_at = None;
            s.saved = true;
            drop(slot);
            show_for(app, json!({"mode":"ask","note":"Not saved."}), serial);
            Ok(())
        }
        CardAction::Ask | CardAction::Confirm => ask_for(
            app,
            wire::clean_question(text.as_deref().unwrap_or("")),
            ticket,
        ),
        CardAction::SelectQuestion => control_for(app, ticket, false),
        CardAction::ChangePlace => places(app, ticket),
        CardAction::PickPlace => {
            let index = text
                .as_deref()
                .and_then(|t| t.parse::<usize>().ok())
                .ok_or("Choose a destination.")?;
            let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
            let s = slot
                .as_mut()
                .filter(|s| ticket_matches(app, ticket, s))
                .ok_or("Selection expired.")?;
            s.destination = Some(s.choices.get(index).ok_or("Choose a destination.")?.clone());
            s.choices.clear();
            drop(slot);
            destination_chosen(app, ticket)
        }
        CardAction::CreatePlace => {
            let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
            let s = slot
                .as_mut()
                .filter(|s| ticket_matches(app, ticket, s))
                .ok_or("Selection expired.")?;
            s.destination = s.create.take();
            drop(slot);
            destination_chosen(app, ticket)
        }
        CardAction::PlaceCancel => {
            toast(app, serial);
            Ok(())
        }
        CardAction::SaveOnly | CardAction::EditCrop => {
            save_session_for(app, action == CardAction::SaveOnly, true, true, ticket)
        }
        CardAction::Save | CardAction::Open => {
            save_session_for(app, false, false, action == CardAction::Open, ticket)
        }
        CardAction::Mic => control_for(app, ticket, true),
        CardAction::Pause
        | CardAction::Resume
        | CardAction::Repeat
        | CardAction::Next
        | CardAction::Stop => {
            let (cues, serial) = {
                let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
                let s = slot
                    .as_mut()
                    .filter(|s| ticket_matches(app, ticket, s))
                    .ok_or("Selection expired.")?;
                let cues = match action {
                    CardAction::Pause => {
                        s.paused = true;
                        s.playback.pause()
                    }
                    CardAction::Resume => {
                        s.paused = false;
                        s.playback.resume(Instant::now())
                    }
                    CardAction::Repeat => s.playback.repeat(Instant::now()),
                    CardAction::Next => s.playback.next(Instant::now()),
                    _ => s.playback.stop(),
                };
                (cues, s.serial)
            };
            run_cues(app, cues, serial);
            Ok(())
        }
        _ => Ok(()),
    }
}
fn snapshot(app: &AppHandle) -> Result<(Arc<NativeFrame>, PixelRect, [u8; 32], u64), String> {
    let (frame, focus, stamp, serial, grant) = {
        let h = state(app)?;
        let slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
        let s = slot
            .as_ref()
            .filter(|s| valid(app, s))
            .ok_or("The screen selection expired.")?;
        (
            s.frame.clone(),
            s.focus,
            s.stamp,
            s.serial,
            s.retention.grant(),
        )
    };
    if !capture_session::retained_current(app, &frame, &grant) {
        revoke_if_serial(app, serial);
        return Err("The Circle source or privacy settings changed.".into());
    }
    Ok((frame, focus, stamp, serial))
}
pub fn retained_grant(
    app: &AppHandle,
    frame: &NativeFrame,
) -> Option<capture_session::CircleGrant> {
    let h = state(app).ok()?;
    let slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
    let s = slot
        .as_ref()
        .filter(|s| std::ptr::eq(s.frame.as_ref(), frame) && valid(app, s))?;
    Some(s.retention.grant())
}
pub fn retained_grant_for_serial(
    app: &AppHandle,
    serial: u64,
) -> Option<capture_session::CircleGrant> {
    let h = state(app).ok()?;
    let slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
    let s = slot
        .as_ref()
        .filter(|s| s.serial == serial && valid(app, s))?;
    Some(s.retention.grant())
}
fn revoke_if_serial(app: &AppHandle, serial: u64) {
    if let Ok(h) = state(app) {
        let closed = {
            let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
            if slot.as_ref().is_none_or(|s| s.serial != serial) {
                return;
            }
            let closed = h.serial.fetch_add(1, Ordering::AcqRel) + 1;
            slot.take();
            closed
        };
        hide_for(app, closed);
    }
}
fn current_retained(app: &AppHandle, frame: &NativeFrame) -> bool {
    retained_grant(app, frame)
        .is_some_and(|grant| capture_session::retained_current(app, frame, &grant))
}
pub fn current_serial(app: &AppHandle) -> Option<u64> {
    let h = state(app).ok()?;
    let slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
    slot.as_ref().filter(|s| valid(app, s)).map(|s| s.serial)
}
pub(crate) fn current_save_serial(app: &AppHandle, session_id: &str) -> Option<u64> {
    let h = state(app).ok()?;
    let slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
    let s = slot
        .as_ref()
        .filter(|s| valid(app, s) && s.saving && s.id == session_id)?;
    Some(s.serial)
}
pub(crate) fn still(app: &AppHandle, serial: u64) -> bool {
    state(app).is_ok_and(|h| {
        h.session
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .is_some_and(|s| s.serial == serial && valid(app, s))
    })
}
fn focus_image(
    frame: &NativeFrame,
    focus: PixelRect,
) -> Result<(crate::screen::secret::SecretBytes, u32, u32), String> {
    if frame.captured.blacked_out.iter().any(|r| {
        r.left < focus.right && focus.left < r.right && r.top < focus.bottom && focus.top < r.bottom
    }) {
        return Err("That selection crosses a protected window. Choose an unobscured area.".into());
    }
    let crop = image::crop(
        &frame.captured.pixels,
        focus.left,
        focus.top,
        focus.right,
        focus.bottom,
    );
    let small = image::downscale_bgra_to_bgr(&crop, 1600);
    let jpg = capture::encode_jpeg(&small, 0.85).map_err(|_| "Couldn't prepare selected image.")?;
    Ok((jpg, small.width, small.height))
}
pub fn read_selected_question(app: &AppHandle, region: Rect) -> Result<u64, String> {
    let serial = current_serial(app).ok_or("The selection expired.")?;
    read_selected_question_checked(app, region, serial, &|| true)
}
pub fn read_selected_question_checked(
    app: &AppHandle,
    region: Rect,
    expected_serial: u64,
    active: &dyn Fn() -> bool,
) -> Result<u64, String> {
    if !active() || !still(app, expected_serial) {
        return Err("The selected question changed.".into());
    }
    let (frame, _, _, serial) = snapshot(app)?;
    if serial != expected_serial {
        return Err("The selected question changed.".into());
    }
    let focus = selection_pixels(
        region,
        frame.target.quartz_points,
        frame.captured.metadata.captured_pixels,
    )
    .ok_or("Select a question inside the captured window.")?;
    read_question(app, focus, serial, active)?;
    Ok(serial)
}
fn read_question(
    app: &AppHandle,
    focus: PixelRect,
    expected_serial: u64,
    active: &dyn Fn() -> bool,
) -> Result<(), String> {
    let (frame, _, stamp, serial) = snapshot(app)?;
    if !active() || serial != expected_serial {
        return Err("The selected question changed.".into());
    }
    let (jpeg, width, height) = focus_image(&frame, focus)?;
    let body = wire::read_question_body(Jpeg {
        bytes: jpeg.as_slice(),
        width,
        height,
    });
    let reply = service_call::post_bound(
        app,
        "api/screen/read-question",
        body.as_slice(),
        &stamp,
        &|| !active() || !still(app, serial),
    )
    .map_err(|e| e.to_string())?;
    let read =
        wire::parse_read_question(reply.as_slice()).ok_or("Neb couldn't read that question.")?;
    if !active() || !still(app, serial) {
        return Err("The selection expired.".into());
    }
    if read.questions.is_empty() {
        show_for(
            app,
            json!({"mode":"message","text":"No question was found. Type your question instead."}),
            serial,
        );
    } else {
        show_for(
            app,
            json!({"mode":"confirm","questions":read.questions}),
            serial,
        );
    }
    Ok(())
}
fn ask(app: &AppHandle, question: String) -> Result<(), String> {
    ask_for(app, question, action_ticket(app)?)
}
fn ask_for(app: &AppHandle, question: String, ticket: ActionTicket) -> Result<(), String> {
    let (frame, focus, stamp, serial) = snapshot_for(app, ticket)?;
    let (config, _) = runtime::of(app)?.snapshot();
    let (id, history) = {
        let h = state(app)?;
        let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
        let s = slot
            .as_mut()
            .filter(|s| ticket_matches(app, ticket, s))
            .ok_or("Selection expired.")?;
        if s.busy || s.saving {
            return Err("Wait for the current explanation.".into());
        }
        s.busy = true;
        s.last_input = Instant::now();
        s.idle_hidden = false;
        s.marking = false;
        s.aborted = false;
        s.save_at = None;
        s.saved = false;
        s.steps.clear();
        s.drawn_steps.clear();
        s.done = false;
        s.current = 0;
        s.summary.clear();
        s.question = if question.is_empty() {
            "Explain this".into()
        } else {
            question.clone()
        };
        s.paused = false;
        s.paused_for_words = false;
        s.playback = Playback::new(
            if config.circle.silent {
                Voice::Captions
            } else {
                Voice::Spoken
            },
            true,
        );
        (s.id.clone(), s.history.clone())
    };
    show_for(app, json!({"mode":"thinking"}), serial);
    let result: Result<(), String> = (|| {
        let (jpeg, width, height) = focus_image(&frame, focus)?;
        let source = super::source_meta::read(app, &frame);
        let head = AskHead {
            session_id: id,
            question: if question.is_empty() {
                Question::None
            } else {
                Question::Typed { text: question }
            },
            marks: {
                let slot = state(app)?;
                let slot = slot.session.lock().unwrap_or_else(|p| p.into_inner());
                marks_for_request(
                    &slot
                        .as_ref()
                        .filter(|s| ticket_matches(app, ticket, s))
                        .ok_or("Selection expired.")?
                        .marks,
                    focus,
                )
            },
            blocks: frame
                .text()
                .blocks(&config.privacy.redaction)
                .into_iter()
                .filter(|b| {
                    b.rect.left < focus.right as i32
                        && b.rect.right > focus.left as i32
                        && b.rect.top < focus.bottom as i32
                        && b.rect.bottom > focus.top as i32
                })
                .map(|b| BlockOut {
                    id: b.id.clone(),
                    text: b.text.clone(),
                    region: box_in(b.rect, focus_bounds(focus)),
                })
                .collect(),
            app: frame.server_meta().app,
            kind: if source.timestamp_sec.is_some()
                || frame.server_meta().video_playing == Some(true)
            {
                ContentKind::Video
            } else if source.url.is_some() {
                ContentKind::Browser
            } else if source
                .title
                .as_deref()
                .is_some_and(|t| t.to_ascii_lowercase().ends_with(".pdf"))
            {
                ContentKind::Pdf
            } else {
                ContentKind::App
            },
            source: Some(SourceOut {
                title: source.title,
                url: source.url,
            }),
            history,
            help: Some(config.help),
        };
        let body = wire::ask_body(
            &head,
            Jpeg {
                bytes: jpeg.as_slice(),
                width,
                height,
            },
            (focus.right - focus.left, focus.bottom - focus.top),
            Jpeg {
                bytes: frame.captured.jpeg.as_slice(),
                width: frame.captured.metadata.encoded_pixels.0,
                height: frame.captured.metadata.encoded_pixels.1,
            },
        );
        let mut lines = LineSplitter::default();
        let mut invalid = false;
        service_call::post_stream_bound(
            app,
            "api/screen/circle-ask",
            body.as_slice(),
            &stamp,
            &|| !ticket_current(app, ticket),
            |chunk| {
                for line in lines.push(chunk) {
                    if let Some(event) = wire::parse_circle_event(&line) {
                        on_event(app, serial, event);
                    } else {
                        invalid = true;
                    }
                }
            },
        )
        .map_err(|e| e.to_string())?;
        if let Some(line) = lines.finish() {
            if let Some(event) = wire::parse_circle_event(&line) {
                on_event(app, serial, event);
            } else {
                invalid = true;
            }
        }
        if invalid {
            return Err("Neb sent an invalid explanation.".into());
        }
        let h = state(app)?;
        let slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
        if !slot.as_ref().is_some_and(|s| s.serial == serial && s.done) {
            return Err("Neb's explanation ended early.".into());
        }
        Ok(())
    })();
    if let Ok(h) = state(app) {
        let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(s) = slot.as_mut().filter(|s| s.serial == serial) {
            s.busy = false;
        }
    }
    if let Err(error) = &result {
        if still(app, serial) {
            let _ = annotate::clear(app);
            show_for(app, json!({"mode":"message","text":error}), serial);
        }
    }
    result
}
fn on_event(app: &AppHandle, serial: u64, event: CircleEvent) {
    if !still(app, serial) {
        return;
    }
    if let CircleEvent::Notebook(spot) = &event {
        if spot.open {
            crate::open_note(app, spot);
        }
        return;
    }
    let mut failure = None;
    let cues = {
        let Ok(h) = state(app) else {
            return;
        };
        let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
        let Some(s) = slot
            .as_mut()
            .filter(|s| s.serial == serial && valid(app, s) && !s.aborted)
        else {
            return;
        };
        match event {
            CircleEvent::Step { step } => {
                if step.index != s.steps.len() || s.done {
                    s.aborted = true;
                    failure = Some("Neb sent steps out of order.".to_owned());
                    vec![]
                } else {
                    let words = step.say.split_whitespace().count();
                    s.steps.push(step);
                    s.playback.step_arrived(words, Instant::now())
                }
            }
            CircleEvent::Done {
                summary,
                follow_up_question,
                concept_hints,
                ..
            } => {
                s.summary = summary.clone();
                s.follow_up = follow_up_question;
                s.concepts = concept_hints;
                s.done = true;
                s.history.push(Turn {
                    question: s.question.clone(),
                    summary,
                });
                if s.history.len() > 3 {
                    s.history.remove(0);
                }
                s.playback.no_more_steps()
            }
            CircleEvent::Abort { speech } => {
                s.aborted = true;
                failure = Some(speech);
                s.playback.stop()
            }
            CircleEvent::Error { message } => {
                s.aborted = true;
                failure = Some(message);
                s.playback.stop()
            }
            CircleEvent::Destination { resolution, .. } => {
                match destination::parse_resolution(resolution) {
                    Some(Resolution::Resolved { place, .. }) => s.destination = Some(place),
                    Some(Resolution::Choose(choices)) => s.choices = choices,
                    Some(Resolution::Missing { mut parent, title }) => {
                        parent.create = Some(title);
                        s.create = Some(parent);
                    }
                    _ => {}
                }
                vec![]
            }
            CircleEvent::Notebook(_) => vec![],
        }
    };
    if let Some(failure) = failure {
        if still(app, serial) {
            let _ = annotate::clear(app);
        }
        show_for(app, json!({"mode":"message","text":failure}), serial);
    } else {
        run_cues(app, cues, serial);
    }
}
fn speak_for(app: &AppHandle, event: &'static str, value: Value, serial: u64) {
    let binding = state(app).ok().and_then(|h| {
        h.session.lock().ok().and_then(|s| {
            s.as_ref()
                .filter(|s| s.serial == serial)
                .map(|s| (s.stamp, s.frame.generation))
        })
    });
    let Some((stamp, generation)) = binding else {
        return;
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if !still(&handle, serial)
            || service_call::credential_stamp(&handle).ok() != Some(stamp)
            || !runtime::of(&handle)
                .is_ok_and(|r| r.generation.load(Ordering::Acquire) == generation)
        {
            return;
        }
        let Some(sign) = handle.try_state::<crate::screen::sign_in::SignIn>() else {
            return;
        };
        let Some(main) = handle.get_webview_window(crate::MAIN) else {
            return;
        };
        if crate::screen::page::require_app_page(&main, sign.app_url()).is_ok() {
            crate::screen::page::dispatch(&handle, event, value);
        }
    });
}
fn run_cues(app: &AppHandle, cues: Vec<Cue>, serial: u64) {
    if !still(app, serial) {
        return;
    }
    for cue in cues {
        match cue {
            Cue::Hush => speak_for(app, crate::screen::page::HUSH, json!({}), serial),
            Cue::Finished => toast(app, serial),
            Cue::Reveal(index) | Cue::Caption(index) | Cue::Say { index, .. } => {
                let item = state(app).ok().and_then(|h| {
                    h.session.lock().ok().and_then(|mut slot| {
                        let s = slot
                            .as_mut()
                            .filter(|s| s.serial == serial && valid(app, s))?;
                        s.current = index;
                        Some((
                            s.frame.clone(),
                            s.focus,
                            s.stamp,
                            s.steps.get(index)?.clone(),
                            s.steps.len(),
                            s.paused,
                            place_view(s),
                        ))
                    })
                });
                if let Some((frame, focus, stamp, step, total, paused, place)) = item {
                    if service_call::credential_stamp(app).ok() != Some(stamp) {
                        cancel_all(app);
                        continue;
                    }
                    match cue {
                        Cue::Reveal(_) => {
                            let actions = map_focus_actions(
                                &step.actions,
                                focus,
                                frame.captured.metadata.captured_pixels,
                            );
                            if let Err(e) = annotate::show_stored_actions(
                                app,
                                &frame,
                                &format!("circle:{serial}:{index}"),
                                actions,
                                false,
                            ) {
                                show_for(app, json!({"mode":"message","text":e}), serial);
                            }
                        }
                        Cue::Caption(_) => show_for(
                            app,
                            json!({"mode":"explain","step":index+1,"total":total,"say":step.say,"paused":paused,"place":place}),
                            serial,
                        ),
                        Cue::Say { token, .. } => {
                            show_for(
                                app,
                                json!({"mode":"explain","step":index+1,"total":total,"say":step.say,"paused":paused,"place":place}),
                                serial,
                            );
                            speak_for(
                                app,
                                crate::screen::page::SAY,
                                json!({"text":step.say,"token":token}),
                                serial,
                            );
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}
fn map_focus_actions(
    actions: &[ScreenAction],
    focus: PixelRect,
    (width, height): (u32, u32),
) -> Vec<ScreenAction> {
    actions
        .iter()
        .map(|a| {
            a.map_coordinates(|x, y| {
                let px = f64::from(focus.left)
                    + f64::from(x) / 1000. * f64::from(focus.right - focus.left);
                let py = f64::from(focus.top)
                    + f64::from(y) / 1000. * f64::from(focus.bottom - focus.top);
                (
                    (px / f64::from(width) * 1000.).round().clamp(0., 1000.) as u16,
                    (py / f64::from(height) * 1000.).round().clamp(0., 1000.) as u16,
                )
            })
        })
        .collect()
}
fn toast(app: &AppHandle, serial: u64) {
    let mode = runtime::of(app)
        .ok()
        .map(|r| r.snapshot().0.circle.save)
        .unwrap_or(crate::screen::config::SaveMode::Never);
    let view=state(app).ok().and_then(|h|h.session.lock().ok().and_then(|mut slot|slot.as_mut().filter(|s|s.serial==serial).map(|s|{
        if s.done && !s.saved && mode == crate::screen::config::SaveMode::Auto && s.save_at.is_none() { s.save_at=Some(Instant::now()+Duration::from_secs(5)); }
        json!({"mode":"toast","note":s.summary.chars().take(200).collect::<String>(),"followUp":s.follow_up,"seconds":s.save_at.map(|at|at.saturating_duration_since(Instant::now()).as_secs()),"canSave":mode != crate::screen::config::SaveMode::Never,"place":place_view(s)})
    })));
    if let Some(view) = view {
        show_for(app, view, serial);
    }
}

fn places(app: &AppHandle, ticket: ActionTicket) -> Result<(), String> {
    let (_, _, stamp, serial) = snapshot_for(app, ticket)?;
    let reply = service_call::post_bound(app, "api/screen/destinations", b"{}", &stamp, &|| {
        !ticket_current(app, ticket)
    })
    .map_err(|e| e.to_string())?;
    let choices = destination::parse_places(reply.as_slice())
        .ok_or("Neb sent invalid notebook destinations.")?;
    let view =
        json!({"mode":"place","places":choices.iter().map(Place::label).collect::<Vec<_>>()});
    let h = state(app)?;
    if let Some(s) = h
        .session
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_mut()
        .filter(|s| ticket_matches(app, ticket, s))
    {
        s.choices = choices;
    }
    show_for(app, view, serial);
    Ok(())
}
fn destination_chosen(app: &AppHandle, ticket: ActionTicket) -> Result<(), String> {
    if let Err(error) = sync_saved_destination(app, ticket) {
        show_for(
            app,
            json!({"mode":"toast","seconds":null,"canSave":false,"note":format!("Couldn't move it. Choose the destination again to retry: {error}")}),
            ticket.serial,
        );
        return Err(error);
    }
    toast(app, ticket.serial);
    Ok(())
}
fn sync_saved_destination(app: &AppHandle, ticket: ActionTicket) -> Result<(), String> {
    let h = state(app)?;
    let movement = {
        let slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
        let s = slot
            .as_ref()
            .filter(|s| ticket_matches(app, ticket, s))
            .ok_or("The explanation was replaced.")?;
        s.destination_move.clone()
    };
    // Serialize moves for this immutable session so a slow earlier selection cannot win
    // after a later one. Never hold the Circle session mutex during native or remote calls.
    let _movement = movement.lock().unwrap_or_else(|p| p.into_inner());
    loop {
        if !ticket_current(app, ticket) {
            return Err("The explanation was replaced.".into());
        }
        let next = {
            let slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
            let s = slot
                .as_ref()
                .filter(|s| ticket_matches(app, ticket, s))
                .ok_or("The explanation was replaced.")?;
            super::entry_destination::pending(
                s.saved_entry.as_ref().map(|saved| saved.clip_id.as_str()),
                s.destination.as_ref(),
                s.applied_destination.as_ref(),
            )
            .map(|(clip_id, place)| (clip_id, place, s.frame.server_meta().app))
        };
        let Some((clip_id, place, source_app)) = next else {
            return Ok(());
        };
        super::entry_destination::move_owned(
            app,
            &clip_id,
            &place,
            source_app.as_deref(),
            &ticket.stamp,
            &|| !ticket_current(app, ticket),
        )?;
        if !ticket_current(app, ticket) {
            return Err("The move was cancelled.".into());
        }
        {
            let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
            let s = slot
                .as_mut()
                .filter(|s| ticket_matches(app, ticket, s))
                .ok_or("The explanation was replaced.")?;
            s.applied_destination = Some(place);
        }
        moved_event(app, ticket, clip_id);
    }
}
fn moved_event(app: &AppHandle, ticket: ActionTicket, clip_id: String) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if !ticket_current(&handle, ticket) {
            return;
        }
        let Some(sign) = handle.try_state::<crate::screen::sign_in::SignIn>() else {
            return;
        };
        let Some(main) = handle.get_webview_window(crate::MAIN) else {
            return;
        };
        if crate::screen::page::require_app_page(&main, sign.app_url()).is_ok() {
            crate::screen::page::dispatch(
                &handle,
                crate::screen::page::ENTRY_SAVED,
                json!({"clipId":clip_id,"open":false}),
            );
        }
    });
}
fn save_session_for(
    app: &AppHandle,
    only: bool,
    preview: bool,
    open: bool,
    ticket: ActionTicket,
) -> Result<(), String> {
    if !ticket_current(app, ticket) {
        return Err("The screen selection expired.".into());
    }
    let serial = {
        let h = state(app)?;
        let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
        let s = slot
            .as_mut()
            .filter(|s| ticket_matches(app, ticket, s))
            .ok_or("Selection expired.")?;
        if s.saving {
            return Err("Wait for the current save.".into());
        }
        s.saving = true;
        s.serial
    };
    let result = save_session_inner(app, only, preview, open, ticket);
    if let Ok(h) = state(app) {
        if let Some(s) = h
            .session
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_mut()
            .filter(|s| ticket_matches(app, ticket, s))
        {
            s.saving = false;
        }
    }
    if let Err(error) = &result {
        if still(app, serial) {
            show_for(
                app,
                json!({"mode":"toast","seconds":null,"canSave":true,"note":error}),
                serial,
            );
        }
    }
    result
}
fn save_session_inner(
    app: &AppHandle,
    only: bool,
    preview: bool,
    open: bool,
    ticket: ActionTicket,
) -> Result<(), String> {
    let h = state(app)?;
    let (frame, mut ink, entry, destination, stamp, serial, saved_entry, marks) = {
        let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
        let s = slot
            .as_mut()
            .filter(|s| ticket_matches(app, ticket, s))
            .ok_or("Selection expired.")?;
        if s.busy {
            return Err("Wait for the explanation to finish.".into());
        }
        s.save_at = None;
        let (ink, stroke_steps) = combined_ink(&s.drawn_steps, s.focus);
        let entry = (!only && s.done).then(|| EntryHead {
            session_id: s.id.clone(),
            student_strokes: student_strokes(&s.marks),
            turn: EntryTurnOut {
                question: s.question.clone(),
                steps: s.steps.iter().map(|s| s.say.clone()).collect(),
                summary: s.summary.clone(),
                follow_up_question: s.follow_up.clone(),
            },
            stroke_steps,
            concept_hints: s.concepts.clone(),
        });
        (
            s.frame.clone(),
            ink,
            entry,
            s.destination.clone(),
            s.stamp,
            s.serial,
            s.saved_entry.clone(),
            student_strokes(&s.marks),
        )
    };
    if only {
        ink.strokes = marks
            .into_iter()
            .map(|m| crate::screen::ink::InkStroke {
                tool: crate::screen::ink::InkTool::Pen,
                color: m.color,
                width: m.width,
                points: m.points,
            })
            .collect();
    }
    if !ticket_current(app, ticket) {
        return Err("The screen selection expired.".into());
    }
    let owner = clip::CircleSaveOwner {
        credential: stamp,
        serial,
    };
    if preview {
        return clip::from_circle_frame(app, frame, ink, entry, destination, owner);
    }
    if let Some(entry) = entry {
        let first_save = saved_entry.is_none();
        let requested_destination = destination.clone();
        let saved_entry = if let Some(saved) = saved_entry {
            clip::append_entry(app, &frame, &saved, ink, entry, owner, open)?;
            saved
        } else {
            clip::save_entry(app, frame, ink, entry, destination, owner, open)?
        };
        if let Some(s) = h
            .session
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_mut()
            .filter(|s| ticket_matches(app, ticket, s))
        {
            s.saved = true;
            s.saved_entry = Some(saved_entry);
            if first_save {
                s.applied_destination = requested_destination;
            }
        }
        // A destination picked during the first upload must move the same entry afterward.
        if let Err(error) = sync_saved_destination(app, ticket) {
            show_for(
                app,
                json!({"mode":"toast","seconds":null,"canSave":false,"note":format!("Saved, but couldn't move it: {error}")}),
                serial,
            );
            return Ok(());
        }
        show_for(app, json!({"mode":"saved","open":open}), serial);
        Ok(())
    } else {
        clip::from_circle_frame(app, frame, ink, None, destination, owner)
    }
}

fn fit(app: &AppHandle, text: Option<&str>, ticket: ActionTicket) -> Result<(), String> {
    let wanted = text
        .and_then(|t| t.parse::<f64>().ok())
        .filter(|h| h.is_finite())
        .ok_or("Invalid card size.")?
        .clamp(236., 560.);
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        if !ticket_current(&app2, ticket) {
            return;
        }
        if let Some(w) = app2.get_webview_window(Surface::Card.label()) {
            if let Some(display) = super::input::cursor().and_then(super::target::display_at) {
                let p = display.points;
                let height = wanted.min(p.height);
                if let Some(rect) = Rect::new(
                    p.x + (p.width - 440.).max(0.),
                    p.y + (p.height - height).max(0.),
                    440.,
                    height,
                ) {
                    let _ = overlay::place(&w, rect);
                }
            }
        }
    })
    .map_err(|_| "Couldn't fit the question card.".into())
}
/// Hold-to-talk routes here while a marked snapshot is active.
pub fn has_visual_marks(app: &AppHandle) -> bool {
    // IslandView can be built while the runtime preferences mutex is held. Never wait for
    // Circle here: its workers independently check preferences while holding their session.
    state(app).is_ok_and(|h| {
        h.session.try_lock().ok().is_some_and(|slot| {
            slot.as_ref().is_some_and(|s| {
                !s.marks.is_empty()
                    && s.serial == h.serial.load(Ordering::Acquire)
                    && s.retention.grant().live()
            })
        })
    })
}
pub fn has_marks(app: &AppHandle) -> bool {
    state(app).is_ok_and(|h| {
        h.session
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .is_some_and(|s| valid(app, s) && !s.marks.is_empty())
    })
}
pub fn has_session(app: &AppHandle) -> bool {
    state(app).is_ok_and(|h| {
        h.session
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .is_some_and(|s| valid(app, s))
    })
}
pub fn pause_for_words(app: &AppHandle) {
    let (cues, serial) = state(app)
        .ok()
        .and_then(|h| {
            let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
            let s = slot.as_mut().filter(|s| valid(app, s))?;
            s.paused_for_words = !s.paused;
            s.paused = true;
            Some((s.playback.pause(), s.serial))
        })
        .unwrap_or_default();
    run_cues(app, cues, serial);
}
pub fn words_cancelled(app: &AppHandle) {
    let (cues, serial) = state(app)
        .ok()
        .and_then(|h| {
            let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
            let s = slot
                .as_mut()
                .filter(|s| valid(app, s) && s.paused_for_words)?;
            s.paused_for_words = false;
            s.paused = false;
            Some((s.playback.resume(Instant::now()), s.serial))
        })
        .unwrap_or_default();
    run_cues(app, cues, serial);
}
pub fn ask_voice(app: &AppHandle, text: &str) -> Result<(), String> {
    ask(app, wire::clean_question(text))
}
pub fn spoken(app: &AppHandle, token: u64) {
    let (cues, serial) = state(app)
        .ok()
        .map(|h| {
            h.session
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_mut()
                .map(|s| (s.playback.spoken(token, Instant::now()), s.serial))
                .unwrap_or_default()
        })
        .unwrap_or_default();
    run_cues(app, cues, serial);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_maps_negative_quartz_origin_to_retina_pixels() {
        let b = Rect::new(-1000., -100., 1000., 500.).unwrap();
        assert_eq!(
            selection_pixels(Rect::new(-900., -50., 200., 100.).unwrap(), b, (2000, 1000)),
            Some(PixelRect {
                left: 200,
                top: 100,
                right: 600,
                bottom: 300
            })
        );
        assert!(
            selection_pixels(Rect::new(-1001., 0., 20., 20.).unwrap(), b, (2000, 1000)).is_none()
        );
    }
    #[test]
    fn focus_actions_are_mapped_to_full_window_norms() {
        let a = ScreenAction::Underline {
            region: Box2 {
                left: 0,
                top: 0,
                right: 1000,
                bottom: 1000,
            },
        };
        assert_eq!(
            map_focus_actions(
                &[a],
                PixelRect {
                    left: 200,
                    top: 100,
                    right: 600,
                    bottom: 300
                },
                (2000, 1000)
            ),
            vec![ScreenAction::Underline {
                region: Box2 {
                    left: 100,
                    top: 100,
                    right: 300,
                    bottom: 300
                }
            }]
        );
    }
    #[test]
    fn semantic_marks_snap_underlines_and_keep_three_numbered_selections() {
        use crate::screen::{
            privacy::{
                detect::RedactionRules,
                redact::{OcrLine, OcrWord},
            },
            screen_text::ScreenText,
        };
        let text = ScreenText::from_ocr(
            &[OcrLine {
                words: vec![OcrWord {
                    text: "Read this".into(),
                    x: 10.,
                    y: 10.,
                    width: 80.,
                    height: 20.,
                }],
            }],
            (1., 1.),
            (400, 300),
            ScreenRect {
                left: 0,
                top: 0,
                right: 400,
                bottom: 300,
            },
            &[],
        );
        let points = vec![(10., 32.), (40., 32.), (90., 32.)];
        let mark = semantic_mark(&text, points, false, 1., &RedactionRules::default()).unwrap();
        assert_eq!(mark.kind, MarkKind::Underline);
        assert_eq!(mark.text, "Read this");
        assert_eq!(mark.region.top, 10);
        let mut marks = vec![];
        for _ in 0..3 {
            assert!(push_mark(&mut marks, mark.clone()).is_ok());
        }
        assert!(push_mark(&mut marks, mark).is_err());
        assert_eq!(marks.len(), 3);
        let out = marks_for_request(
            &marks,
            PixelRect {
                left: 0,
                top: 0,
                right: 400,
                bottom: 300,
            },
        );
        assert_eq!(
            out.iter().map(|m| m.number).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(out[0].kind, MarkKind::Underline);
        assert!(!out[0].polygon.is_empty());
    }
    #[test]
    fn saved_circle_ink_keeps_each_step_and_student_marks() {
        let stroke = crate::screen::ink::InkStroke {
            tool: crate::screen::ink::InkTool::Pen,
            color: "#ffffff".into(),
            width: 2.,
            points: vec![[10., 10., 0.5, 0.], [20., 20., 0.5, 1.]],
        };
        let mut steps = std::collections::BTreeMap::new();
        for n in [1, 2] {
            steps.insert(
                n,
                DrawnInk {
                    id: n as u64,
                    strokes: vec![stroke.clone()],
                    cards: vec![],
                    bbox: Some([10., 10., 10., 10.]),
                    step: None,
                },
            );
        }
        let (ink, indexes) = combined_ink(
            &steps,
            PixelRect {
                left: 0,
                top: 0,
                right: 100,
                bottom: 100,
            },
        );
        assert_eq!(indexes, vec![1, 2]);
        assert_eq!(ink.strokes.len(), 2);
        let mark = SelectionMark {
            kind: MarkKind::Underline,
            points: vec![(10., 30.), (90., 30.)],
            region: ScreenRect {
                left: 10,
                top: 10,
                right: 90,
                bottom: 30,
            },
            text: "Text".into(),
            dashed: false,
        };
        assert_eq!(student_strokes(&[mark])[0].points.len(), 2);
    }
}

#[cfg(test)]
mod delayed_drawing_tests {
    use super::while_current;
    use std::{
        cell::Cell,
        sync::atomic::{AtomicU64, Ordering},
    };
    #[test]
    fn deferred_cancelled_drawing_worker_neither_captures_nor_mutates_replacement() {
        let drawing = AtomicU64::new(3);
        let circle = AtomicU64::new(7);
        let captures = Cell::new(0);
        let mutations = Cell::new(0);
        let active = || drawing.load(Ordering::Acquire) == 3 && circle.load(Ordering::Acquire) == 7;
        drawing.store(4, Ordering::Release);
        circle.store(9, Ordering::Release);
        assert!(while_current(&active, || {
            captures.set(captures.get() + 1);
            Ok(())
        })
        .is_err());
        assert!(while_current(&active, || {
            mutations.set(mutations.get() + 1);
            Ok(())
        })
        .is_err());
        assert_eq!((captures.get(), mutations.get()), (0, 0));
        let replacement =
            || drawing.load(Ordering::Acquire) == 4 && circle.load(Ordering::Acquire) == 9;
        assert!(while_current(&replacement, || {
            mutations.set(mutations.get() + 1);
            Ok(())
        })
        .is_ok());
        assert_eq!(mutations.get(), 1);
    }
}

#[cfg(test)]
mod lifetime_tests {
    use super::*;
    #[test]
    fn active_explanations_outlive_pending_capture_expiry_but_idle_marks_do_not() {
        assert_eq!(
            idle_action(false, false, Duration::from_secs(600)),
            IdleAction::Keep
        );
        assert_eq!(
            idle_action(true, true, Duration::from_secs(600)),
            IdleAction::Keep
        );
        assert_eq!(
            idle_action(true, false, Duration::from_secs(19)),
            IdleAction::Keep
        );
        assert_eq!(
            idle_action(true, false, Duration::from_secs(20)),
            IdleAction::Hide
        );
        assert_eq!(
            idle_action(true, false, Duration::from_secs(80)),
            IdleAction::Close
        );
    }
}
