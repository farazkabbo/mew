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
        self as wire, AskHead, CircleEvent, ContentKind, Jpeg, MarkOut, Question, Turn,
    },
    circle_steps::{Cue, Playback, Voice},
    destination::{self, Place, Resolution},
    frame::ScreenRect,
    image,
    ink::DrawnInk,
    marks::MarkKind,
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
    focus: PixelRect,
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
    done: bool,
    busy: bool,
    save_at: Option<Instant>,
    saved: bool,
    aborted: bool,
    destination: Option<Place>,
    choices: Vec<Place>,
    create: Option<Place>,
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
    Instant::now() < s.frame.expires_at()
        && !reset
        && c.is_on()
        && !c.paused
        && c.privacy.show_in_captures
        && r.generation.load(Ordering::Acquire) == s.frame.generation
        && state(app).is_ok_and(|h| h.serial.load(Ordering::Acquire) == s.serial)
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
                    .is_some_and(|s| {
                        !s.busy && !s.saved && s.save_at.is_some_and(|at| Instant::now() >= at)
                    });
                if auto {
                    if let Err(error) = save_session(&app, false, false, false) {
                        message(&app, &error);
                    }
                }
            }
        })
        .map_err(|_| "Couldn't start Circle & Ask playback.".to_owned())?;
    Ok(())
}
fn hide(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window(Surface::Card.label()) {
            let _ = overlay::hide(&w);
        }
        let _ = annotate::clear(&handle);
    });
    crate::screen::page::dispatch(app, crate::screen::page::HUSH, json!({}));
}
pub fn cancel_all(app: &AppHandle) {
    if let Ok(h) = state(app) {
        h.serial.fetch_add(1, Ordering::AcqRel);
        h.session.lock().unwrap_or_else(|p| p.into_inner()).take();
    }
    hide(app);
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
    cancel_all(app);
    let h = state(app)?;
    let serial = h.serial.fetch_add(1, Ordering::AcqRel) + 1;
    let generation = runtime::of(app)?.generation.load(Ordering::Acquire);
    let frame = capture_session::capture_window(app, Intent::Circle, generation)?;
    if expected
        .as_ref()
        .is_some_and(|expected| *expected != frame.target)
    {
        return Err("The selection's window changed. Select it again.".into());
    }
    let focus = selection_pixels(
        region,
        frame.target.quartz_points,
        frame.captured.metadata.captured_pixels,
    )
    .ok_or("Select an area inside the foreground window.")?;
    let stamp = service_call::credential_stamp(app).map_err(|e| e.to_string())?;
    if !capture_session::is_current(app, &frame) || h.serial.load(Ordering::Acquire) != serial {
        return Err("The selection was cancelled.".into());
    }
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(|_| "Couldn't start Circle & Ask.")?;
    let id = uuid::Builder::from_random_bytes(random)
        .into_uuid()
        .to_string();
    let silent = runtime::of(app)?.snapshot().0.circle.silent;
    *h.session.lock().unwrap_or_else(|p| p.into_inner()) = Some(Session {
        serial,
        id,
        frame: Arc::new(frame),
        focus,
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
        done: false,
        busy: false,
        save_at: None,
        saved: false,
        aborted: false,
        destination: None,
        choices: vec![],
        create: None,
    });
    show(app, json!({"mode":"ask","silent":silent,"place":{}}));
    Ok(())
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
fn show(app: &AppHandle, view: Value) {
    let serial = state(app).ok().and_then(|h| {
        h.session
            .lock()
            .ok()
            .and_then(|s| s.as_ref().map(|s| s.serial))
    });
    if let Some(serial) = serial {
        show_for(app, view, serial);
    }
}
fn show_for(app: &AppHandle, view: Value, serial: u64) {
    let Some((generation, stamp)) = state(app).ok().and_then(|h| {
        h.session.lock().ok().and_then(|s| {
            s.as_ref()
                .filter(|s| s.serial == serial)
                .map(|s| (s.frame.generation, s.stamp))
        })
    }) else {
        return;
    };
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
fn message(app: &AppHandle, text: &str) {
    show(
        app,
        json!({"mode":"message","text":text.chars().take(300).collect::<String>()}),
    );
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
            json!({"mode":"explain","step":s.current+1,"total":s.steps.len(),"say":step.say,"paused":s.paused,"place":place_view(s)}),
        )
    } else {
        Ok(
            json!({"mode":if s.busy { "thinking" } else { "ask" },"silent":runtime::of(window.app_handle())?.snapshot().0.circle.silent,"place":place_view(s)}),
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
#[tauri::command]
pub async fn screen_circle_card(
    window: WebviewWindow,
    action: CardAction,
    text: Option<String>,
) -> Result<(), String> {
    overlay::require_surface(&window, Surface::Card)?;
    let app = window.app_handle().clone();
    if matches!(action, CardAction::Close | CardAction::Undo) {
        cancel_all(&app);
        return Ok(());
    }
    if action == CardAction::Fit {
        return fit(&app, text.as_deref());
    }
    tauri::async_runtime::spawn_blocking(move || perform(&app, action, text))
        .await
        .map_err(|_| "Circle & Ask stopped.".to_owned())?
}
fn perform(app: &AppHandle, action: CardAction, text: Option<String>) -> Result<(), String> {
    let h = state(app)?;
    let account = service_call::credential_stamp(app).map_err(|e| e.to_string())?;
    let serial = {
        let slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
        let s = slot
            .as_ref()
            .filter(|s| valid(app, s))
            .ok_or("The screen selection expired.")?;
        if account != s.stamp {
            return Err("The account changed. Select the screen again.".into());
        }
        s.serial
    };
    match action {
        CardAction::Ask | CardAction::Confirm => {
            ask(app, wire::clean_question(text.as_deref().unwrap_or("")))
        }
        CardAction::SelectQuestion => read_question(app),
        CardAction::ChangePlace => places(app),
        CardAction::PickPlace => {
            let index = text
                .as_deref()
                .and_then(|t| t.parse::<usize>().ok())
                .ok_or("Choose a destination.")?;
            let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
            let s = slot.as_mut().ok_or("Selection expired.")?;
            s.destination = Some(s.choices.get(index).ok_or("Choose a destination.")?.clone());
            s.choices.clear();
            drop(slot);
            toast(app, serial);
            Ok(())
        }
        CardAction::CreatePlace => {
            let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
            let s = slot.as_mut().ok_or("Selection expired.")?;
            s.destination = s.create.take();
            drop(slot);
            toast(app, serial);
            Ok(())
        }
        CardAction::PlaceCancel => {
            toast(app, serial);
            Ok(())
        }
        CardAction::SaveOnly | CardAction::EditCrop => {
            save_preview(app, action == CardAction::SaveOnly)
        }
        CardAction::Save | CardAction::Open => {
            save_session(app, false, false, action == CardAction::Open)
        }
        CardAction::Mic => super::ask::toggle_mic(app),
        CardAction::Pause
        | CardAction::Resume
        | CardAction::Repeat
        | CardAction::Next
        | CardAction::Stop => {
            let (cues, serial) = {
                let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
                let s = slot.as_mut().ok_or("Selection expired.")?;
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
    let h = state(app)?;
    let slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
    let s = slot
        .as_ref()
        .filter(|s| valid(app, s))
        .ok_or("The screen selection expired.")?;
    Ok((s.frame.clone(), s.focus, s.stamp, s.serial))
}
fn still(app: &AppHandle, serial: u64) -> bool {
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
fn read_question(app: &AppHandle) -> Result<(), String> {
    let (frame, focus, stamp, serial) = snapshot(app)?;
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
        &|| !still(app, serial),
    )
    .map_err(|e| e.to_string())?;
    let read =
        wire::parse_read_question(reply.as_slice()).ok_or("Neb couldn't read that question.")?;
    if !still(app, serial) {
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
    let (frame, focus, stamp, serial) = snapshot(app)?;
    let (config, _) = runtime::of(app)?.snapshot();
    let (id, history) = {
        let h = state(app)?;
        let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
        let s = slot.as_mut().ok_or("Selection expired.")?;
        if s.busy {
            return Err("Wait for the current explanation.".into());
        }
        s.busy = true;
        s.aborted = false;
        s.save_at = None;
        s.saved = false;
        s.steps.clear();
        s.done = false;
        s.current = 0;
        s.summary.clear();
        s.question = if question.is_empty() {
            "Explain this".into()
        } else {
            question.clone()
        };
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
        let text = frame.text().text_in(
            ScreenRect {
                left: focus.left as i32,
                top: focus.top as i32,
                right: focus.right as i32,
                bottom: focus.bottom as i32,
            },
            &config.privacy.redaction,
        );
        let head = AskHead {
            session_id: id,
            question: if question.is_empty() {
                Question::None
            } else {
                Question::Typed { text: question }
            },
            marks: vec![MarkOut {
                number: 1,
                kind: MarkKind::Circle,
                region: Box2 {
                    left: 0,
                    top: 0,
                    right: 1000,
                    bottom: 1000,
                },
                polygon: vec![],
                text,
            }],
            blocks: vec![],
            app: frame.server_meta().app,
            kind: ContentKind::App,
            source: None,
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
            &|| !still(app, serial),
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
                            if let Err(e) =
                                annotate::show_stored_actions(app, &frame, "circle", actions, false)
                            {
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

fn places(app: &AppHandle) -> Result<(), String> {
    let (_, _, stamp, serial) = snapshot(app)?;
    let reply = service_call::post_bound(app, "api/screen/destinations", b"{}", &stamp, &|| {
        !still(app, serial)
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
        .filter(|s| s.serial == serial)
    {
        s.choices = choices;
    }
    show_for(app, view, serial);
    Ok(())
}
fn save_preview(app: &AppHandle, only: bool) -> Result<(), String> {
    save_session(app, only, true, true)
}
fn save_session(app: &AppHandle, only: bool, preview: bool, open: bool) -> Result<(), String> {
    let h = state(app)?;
    let (frame, focus, entry, destination, stamp, serial) = {
        let mut slot = h.session.lock().unwrap_or_else(|p| p.into_inner());
        let s = slot
            .as_mut()
            .filter(|s| valid(app, s))
            .ok_or("Selection expired.")?;
        if s.busy {
            return Err("Wait for the explanation to finish.".into());
        }
        s.save_at = None;
        let entry = (!only && s.done).then(|| EntryHead {
            session_id: s.id.clone(),
            student_strokes: vec![],
            turn: EntryTurnOut {
                question: s.question.clone(),
                steps: s.steps.iter().map(|s| s.say.clone()).collect(),
                summary: s.summary.clone(),
                follow_up_question: s.follow_up.clone(),
            },
            stroke_steps: vec![],
            concept_hints: s.concepts.clone(),
        });
        (
            s.frame.clone(),
            s.focus,
            entry,
            s.destination.clone(),
            s.stamp,
            s.serial,
        )
    };
    let ink = annotate::drawn_for_frame(app, &frame).unwrap_or(DrawnInk {
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
    });
    let entry = entry.map(|mut entry| {
        entry.stroke_steps = vec![0; ink.strokes.len()];
        entry
    });
    if preview {
        return clip::from_shared_frame(app, frame, ink, entry, destination);
    }
    if let Some(entry) = entry {
        clip::save_entry(app, frame, ink, entry, destination, stamp, open)?;
        if let Some(s) = h
            .session
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_mut()
            .filter(|s| s.serial == serial)
        {
            s.saved = true;
        }
        show_for(app, json!({"mode":"saved","open":open}), serial);
        Ok(())
    } else {
        clip::from_shared_frame(app, frame, ink, None, destination)
    }
}

fn fit(app: &AppHandle, text: Option<&str>) -> Result<(), String> {
    let wanted = text
        .and_then(|t| t.parse::<f64>().ok())
        .filter(|h| h.is_finite())
        .ok_or("Invalid card size.")?
        .clamp(236., 560.);
    let app2 = app.clone();
    app.run_on_main_thread(move || {
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
pub fn has_session(app: &AppHandle) -> bool {
    state(app).is_ok_and(|h| {
        h.session
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .is_some_and(|s| valid(app, s))
    })
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
}
