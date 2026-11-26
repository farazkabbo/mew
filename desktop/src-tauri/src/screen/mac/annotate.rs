//! Mac tutor ink: image-local capture geometry becomes display-local backing pixels, while
//! native panels are placed in Quartz points. Only OCR rectangles reach the bundled renderer.
use super::{
    capture_session::{self, NativeFrame},
    overlay::{self, Surface},
    pipeline::Target,
    runtime,
    target::{self, Display, Point, Rect},
};
use crate::screen::{
    frame::ScreenRect,
    ink::{self, DrawnInk, InkRequest},
    protocol::{self, FocusKind, ScreenAction},
    screen_text::TextAnchor,
    secret::SecretBytes,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewWindow};

#[path = "annotate_watch.rs"]
mod native_watch;
const DRAW: &str = "mew:ink-draw";
const CLEAR: &str = "mew:ink-clear";
const FADE: &str = "mew:ink-fade";
const ACK_TIMEOUT: Duration = Duration::from_secs(5);
const KEEP_AFTER_FADE: Duration = Duration::from_secs(120);
type SaveHandler = Arc<dyn Fn(AppHandle) -> Result<(), String> + Send + Sync>;
#[derive(Default)]
struct State {
    next_id: u64,
    ready: bool,
    turn: Option<Turn>,
    save: Option<SaveHandler>,
}
#[derive(Default)]
struct Host(Mutex<State>);
struct Turn {
    id: u64,
    target: Target,
    generation: u64,
    expires_at: Instant,
    shown_at: Instant,
    display: Display,
    capture_pixels: (u32, u32),
    capture_area: Rect,
    actions: Vec<ScreenAction>,
    seed: String,
    request: InkRequest,
    drawn: Option<DrawnInk>,
    frame: Option<Arc<NativeFrame>>,
    coaching: bool,
    faded_at: Option<Instant>,
    stored_card: bool,
    anchor: Option<TextAnchor>,
    focus_text: SecretBytes,
    focus_kind: FocusKind,
    content_stamp: capture_session::ContentStamp,
    native_content_watch: bool,
}
fn state(app: &AppHandle) -> Result<tauri::State<'_, Host>, String> {
    app.try_state()
        .ok_or_else(|| "Mac ink is not initialized.".into())
}
pub fn setup(app: &AppHandle) -> Result<(), String> {
    app.add_capability(
        tauri::ipc::CapabilityBuilder::new("mac-tutor-ink")
            .local(true)
            .window(Surface::Ink.label())
            .permission("allow-screen-ink-drawn")
            .permission("allow-screen-ink-ready"),
    )
    .map_err(|_| "Couldn't configure local tutor ink.")?;
    app.add_capability(
        tauri::ipc::CapabilityBuilder::new("mac-tutor-ink-pill")
            .local(true)
            .window(Surface::Pill.label())
            .permission("allow-screen-ink-pill"),
    )
    .map_err(|_| "Couldn't configure the local ink pill.")?;
    if !app.manage(Host::default()) {
        return Err("Mac tutor ink is already initialized.".into());
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("neb-mac-ink-watch".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(250));
            let active = state(&app).ok().and_then(|s| {
                let mut s = s.0.lock().unwrap_or_else(|p| p.into_inner());
                if s.turn
                    .as_ref()
                    .is_some_and(|t| t.faded_at.is_some_and(|f| f.elapsed() >= KEEP_AFTER_FADE))
                {
                    s.turn = None;
                }
                s.turn.as_ref().filter(|t| t.faded_at.is_none()).map(|t| {
                    (
                        t.id,
                        t.target.clone(),
                        t.generation,
                        t.expires_at,
                        t.shown_at,
                        t.drawn.is_some(),
                        t.stored_card,
                        t.content_stamp,
                        t.native_content_watch,
                    )
                })
            });
            if let Some((
                id,
                target,
                generation,
                expires,
                shown,
                drawn,
                stored_card,
                content_stamp,
                native_content_watch,
            )) = active
            {
                if Instant::now() >= expires
                    || (!native_content_watch && shown.elapsed() >= Duration::from_secs(5))
                    || (!drawn && shown.elapsed() >= ACK_TIMEOUT)
                    || (capture_session::content_stamp() != content_stamp
                        && !(stored_card && stored_target_current(&app, &target, generation))
                        && !(only_pill_click(content_stamp, capture_session::content_stamp())
                            && pointer_on_pill(&app, id)))
                    || !(capture_session::is_target_current(&app, &target, generation)
                        || (stored_card && stored_target_current(&app, &target, generation)))
                {
                    let _ = fade(&app, id);
                }
            }
        })
        .map_err(|_| "Couldn't monitor tutor ink.")?;
    Ok(())
}
pub fn set_save_handler(app: &AppHandle, handler: SaveHandler) -> Result<(), String> {
    state(app)?.0.lock().unwrap_or_else(|p| p.into_inner()).save = Some(handler);
    Ok(())
}

/// Pure conversion for the shared renderer: its canvas draws in device backing pixels, and
/// its normalized 0..1000 action coordinates are left untouched. No global pixel space exists.
fn transform_request(
    mut request: InkRequest,
    frame: Rect,
    display: Display,
    capture: (u32, u32),
) -> Result<InkRequest, String> {
    let sx = display.scale_x();
    let sy = display.scale_y();
    if capture.0 == 0 || capture.1 == 0 || !(1. ..=8.).contains(&sx) || (sx - sy).abs() > 0.001 {
        return Err("This display's ink scale is unsupported.".into());
    }
    let fx = frame.width * sx / f64::from(capture.0);
    let fy = frame.height * sy / f64::from(capture.1);
    let ox = (frame.x - display.points.x) * sx;
    let oy = (frame.y - display.points.y) * sy;
    let r = request.frame;
    request.frame = [
        (ox + f64::from(r[0]) * fx) as f32,
        (oy + f64::from(r[1]) * fy) as f32,
        (f64::from(r[2]) * fx) as f32,
        (f64::from(r[3]) * fy) as f32,
    ];
    request.bounds = [
        0.,
        0.,
        display.pixel_width as f32,
        display.pixel_height as f32,
    ];
    request.obstacles = request
        .obstacles
        .into_iter()
        .map(|r| {
            [
                (ox + f64::from(r[0]) * fx) as f32,
                (oy + f64::from(r[1]) * fy) as f32,
                (f64::from(r[2]) * fx) as f32,
                (f64::from(r[3]) * fy) as f32,
            ]
        })
        .collect();
    request.text_height = request.text_height.map(|h| (f64::from(h) * fy) as f32);
    request.scale = sx as f32;
    request.fly_from = None;
    Ok(request)
}
fn display_for_frame(frame: &NativeFrame) -> Result<Display, String> {
    let rect = frame.captured.metadata.quartz_points;
    target::display_at(Point {
        x: rect.x + rect.width / 2.,
        y: rect.y + rect.height / 2.,
    })
    .filter(|d| d.pixel_crop(rect).is_some())
    .ok_or_else(|| "Tutor ink requires a window wholly on one display.".into())
}
fn validate_actions(actions: &[ScreenAction]) -> bool {
    // Notes Check's local marks are also supported; they are never accepted as model actions
    // by the transport validator. Check every individual action through its ordinary twin.
    actions.len() <= 24
        && actions.iter().all(|action| {
            let ordinary = match action {
                ScreenAction::CheckMark { region } => ScreenAction::Underline { region: *region },
                ScreenAction::CircleRegion { region, label, .. } => ScreenAction::CircleRegion {
                    region: *region,
                    label: label.clone(),
                    tone: None,
                },
                a => a.clone(),
            };
            crate::screen::protocol::actions_are_valid(&[ordinary])
        })
}
pub fn show_actions(
    app: &AppHandle,
    frame: &NativeFrame,
    seed: &str,
    actions: Vec<ScreenAction>,
    coaching: bool,
) -> Result<(), String> {
    show_impl(app, frame, seed, actions, coaching, false)
}
/// Rendering an already-redacted Circle snapshot after deliberate local-card focus. The
/// caller additionally binds its account stamp. It cannot authorize a new capture.
pub fn show_stored_actions(
    app: &AppHandle,
    frame: &NativeFrame,
    seed: &str,
    actions: Vec<ScreenAction>,
    coaching: bool,
) -> Result<(), String> {
    show_impl(app, frame, seed, actions, coaching, true)
}
fn show_impl(
    app: &AppHandle,
    frame: &NativeFrame,
    seed: &str,
    actions: Vec<ScreenAction>,
    coaching: bool,
    stored_card: bool,
) -> Result<(), String> {
    if !(capture_session::is_current(app, frame)
        || (stored_card && capture_session::is_stored_current(app, frame)))
    {
        return Err("The screen answer is no longer current.".into());
    }
    if !(frame.input_is_unchanged()
        || stored_card && capture_session::is_stored_current(app, frame))
    {
        return Err("The content moved while Neb was answering. Ask to show it again.".into());
    }
    let (config, _) = runtime::of(app)?.snapshot();
    if !config.privacy.show_in_captures {
        return Err(
            "Enable visible Mac overlays in local privacy settings before showing tutor ink."
                .into(),
        );
    }
    if seed.chars().count() > 100 || !validate_actions(&actions) {
        return Err("Invalid tutor ink.".into());
    }
    if !actions
        .iter()
        .any(|a| !matches!(a, ScreenAction::FocusRegion { .. } | ScreenAction::Clear))
    {
        return clear(app);
    }
    let display = display_for_frame(frame)?;
    let id = {
        let state = state(app)?;
        let mut s = state.0.lock().unwrap_or_else(|p| p.into_inner());
        s.next_id = s
            .next_id
            .checked_add(1)
            .ok_or("Tutor ink identifiers exhausted.")?;
        s.next_id
    };
    let request = transform_request(
        ink::ink_request(
            id,
            seed,
            &actions,
            &frame.server_meta(),
            frame.text(),
            true,
            None,
        ),
        frame.captured.metadata.quartz_points,
        display,
        frame.captured.metadata.captured_pixels,
    )?;
    let (anchor, focus_text, focus_kind) =
        anchor_for_frame(frame, &actions, &config.privacy.redaction);
    {
        let state = state(app)?;
        let mut s = state.0.lock().unwrap_or_else(|p| p.into_inner());
        s.turn = Some(Turn {
            id,
            target: frame.target.clone(),
            generation: frame.generation,
            expires_at: frame.expires_at(),
            shown_at: Instant::now(),
            display,
            capture_pixels: frame.captured.metadata.captured_pixels,
            capture_area: frame.captured.metadata.quartz_points,
            actions,
            seed: seed.to_owned(),
            request,
            drawn: None,
            frame: None,
            coaching,
            faded_at: None,
            stored_card,
            anchor,
            focus_text,
            focus_kind,
            content_stamp: frame.content_stamp(),
            native_content_watch: false,
        });
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let active = state(&handle).ok().and_then(|s| {
            s.0.lock()
                .unwrap_or_else(|p| p.into_inner())
                .turn
                .as_ref()
                .filter(|t| t.id == id && t.faded_at.is_none())
                .map(|t| (t.target.clone(), t.generation, t.expires_at))
        });
        let Some((target, generation, expires)) = active else {
            return;
        };
        if Instant::now() >= expires
            || !(capture_session::target_is_current_main(&handle, &target, generation)
                || (stored_card
                    && capture_session::stored_target_current_main(&handle, &target, generation)))
        {
            let _ = clear_if_id(&handle, id);
            return;
        }
        let native_content_watch = native_watch::start(&handle, id, &target);
        if let Ok(state) = state(&handle) {
            if let Some(t) = state
                .0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .turn
                .as_mut()
                .filter(|t| t.id == id)
            {
                t.native_content_watch = native_content_watch;
            }
        }
        let Ok(window) = overlay::ensure(&handle, Surface::Ink) else {
            let _ = clear_if_id(&handle, id);
            return;
        };
        if !coaching {
            let _ = overlay::ensure(&handle, Surface::Pill);
        }
        if overlay::place(&window, display.points).is_err()
            || overlay::show_quietly(&window).is_err()
        {
            let _ = clear_if_id(&handle, id);
            return;
        }
        let ready = state(&handle)
            .ok()
            .is_some_and(|s| s.0.lock().unwrap_or_else(|p| p.into_inner()).ready);
        if ready {
            let _ = dispatch_pending(&handle, id);
        }
    })
    .map_err(|_| "Couldn't show tutor ink.")?;
    if !coaching {
        crate::mac_shortcut::reserve_escape(app)?;
    }
    Ok(())
}
pub fn show_owned_actions(
    app: &AppHandle,
    frame: NativeFrame,
    seed: &str,
    actions: Vec<ScreenAction>,
    coaching: bool,
) -> Result<(), String> {
    show_actions(app, &frame, seed, actions, coaching)?;
    let state = state(app)?;
    let mut s = state.0.lock().unwrap_or_else(|p| p.into_inner());
    let turn = s
        .turn
        .as_mut()
        .filter(|t| {
            t.target == frame.target && t.generation == frame.generation && t.faded_at.is_none()
        })
        .ok_or("The ink session changed.")?;
    turn.frame = Some(Arc::new(frame));
    let pill = turn
        .drawn
        .as_ref()
        .and_then(|ink| ink.bbox)
        .filter(|_| !turn.coaching)
        .map(|b| {
            let sx = turn.display.scale_x();
            let sy = turn.display.scale_y();
            let fx = turn.capture_area.width * sx / f64::from(turn.capture_pixels.0);
            let fy = turn.capture_area.height * sy / f64::from(turn.capture_pixels.1);
            let ox = (turn.capture_area.x - turn.display.points.x) * sx;
            let oy = (turn.capture_area.y - turn.display.points.y) * sy;
            (
                turn.id,
                turn.display,
                [
                    (ox + f64::from(b[0]) * fx) as f32,
                    (oy + f64::from(b[1]) * fy) as f32,
                    (f64::from(b[2]) * fx) as f32,
                    (f64::from(b[3]) * fy) as f32,
                ],
            )
        });
    drop(s);
    if let Some((id, display, bbox)) = pill {
        show_pill(app, id, display, bbox)?;
    }
    Ok(())
}
fn dispatch_pending(app: &AppHandle, id: u64) -> Result<(), String> {
    // Serialize the actual eval submission with clear/fade. Dropping the state lock before
    // submission would let a cancelled pending request enqueue a DRAW after CLEAR.
    let state = state(app)?;
    let s = state.0.lock().unwrap_or_else(|p| p.into_inner());
    let t = s
        .turn
        .as_ref()
        .filter(|t| t.id == id && t.faded_at.is_none() && t.expires_at > Instant::now())
        .ok_or("No active ink request.")?;
    if runtime::of(app)?
        .generation
        .load(std::sync::atomic::Ordering::Acquire)
        != t.generation
    {
        return Err("The ink session changed.".into());
    }
    overlay::dispatch(
        app,
        Surface::Ink,
        DRAW,
        &serde_json::to_value(&t.request).map_err(|_| "Invalid tutor ink request.")?,
    )
    .map_err(|_| "Couldn't draw tutor ink.".into())
}

pub fn visible(app: &AppHandle) -> bool {
    state(app).ok().is_some_and(|s| {
        s.0.lock()
            .unwrap_or_else(|p| p.into_inner())
            .turn
            .as_ref()
            .is_some_and(|t| t.faded_at.is_none() && t.expires_at > Instant::now())
    })
}
pub fn clear(app: &AppHandle) -> Result<(), String> {
    if let Ok(state) = state(app) {
        let mut s = state.0.lock().unwrap_or_else(|p| p.into_inner());
        let old_id = s.turn.as_ref().map(|t| t.id);
        s.turn = None;
        hide(app, CLEAR);
        if let Some(id) = old_id {
            native_watch::stop(app, id);
        }
    } else {
        hide(app, CLEAR);
    }
    crate::mac_shortcut::release_escape(app);
    Ok(())
}
fn clear_if_id(app: &AppHandle, id: u64) -> Result<(), String> {
    let state = state(app)?;
    let mut s = state.0.lock().unwrap_or_else(|p| p.into_inner());
    if s.turn.as_ref().is_none_or(|t| t.id != id) {
        return Ok(());
    }
    s.turn = None;
    hide(app, CLEAR);
    native_watch::stop(app, id);
    drop(s);
    crate::mac_shortcut::release_escape(app);
    Ok(())
}

fn hide(app: &AppHandle, event: &str) {
    if app.get_webview_window(Surface::Ink.label()).is_some() {
        let _ = overlay::dispatch(app, Surface::Ink, event, &json!({}));
        if event == CLEAR {
            if let Some(w) = app.get_webview_window(Surface::Ink.label()) {
                let _ = overlay::hide(&w);
            }
        }
    }
    if let Some(w) = app.get_webview_window(Surface::Pill.label()) {
        let _ = overlay::hide(&w);
    }
}
fn fade(app: &AppHandle, id: u64) -> Result<(), String> {
    let state = state(app)?;
    let mut s = state.0.lock().unwrap_or_else(|p| p.into_inner());
    let Some(turn) = s.turn.as_mut().filter(|t| t.id == id) else {
        return Ok(());
    };
    turn.faded_at = Some(Instant::now());
    turn.frame = None;
    turn.drawn = None;
    hide(app, FADE);
    drop(s);
    native_watch::stop(app, id);
    crate::mac_shortcut::release_escape(app);
    Ok(())
}

/// Returned strokes are image-local capture pixels, compatible with the image-local metadata
/// and redacted full-resolution frame. The renderer's global display origin never leaks here.
fn to_image(mut ink: DrawnInk, turn: &Turn) -> DrawnInk {
    let sx = turn.display.scale_x();
    let sy = turn.display.scale_y();
    let fx = turn.capture_area.width * sx / f64::from(turn.capture_pixels.0);
    let fy = turn.capture_area.height * sy / f64::from(turn.capture_pixels.1);
    let ox = (turn.capture_area.x - turn.display.points.x) * sx;
    let oy = (turn.capture_area.y - turn.display.points.y) * sy;
    let r = |r: ink::Rect| {
        [
            ((f64::from(r[0]) - ox) / fx) as f32,
            ((f64::from(r[1]) - oy) / fy) as f32,
            (f64::from(r[2]) / fx) as f32,
            (f64::from(r[3]) / fy) as f32,
        ]
    };
    for stroke in &mut ink.strokes {
        stroke.width = (f64::from(stroke.width) / fx) as f32;
        for p in &mut stroke.points {
            p[0] = ((f64::from(p[0]) - ox) / fx) as f32;
            p[1] = ((f64::from(p[1]) - oy) / fy) as f32;
        }
    }
    ink.cards = ink.cards.into_iter().map(r).collect();
    ink.bbox = ink.bbox.map(r);
    ink
}
fn accept_ack(turn: &Turn, ink: &DrawnInk) -> bool {
    ink.id == turn.id
        && ink.step.is_none()
        && turn.drawn.is_none()
        && turn.faded_at.is_none()
        && Instant::now() < turn.expires_at
        && turn.shown_at.elapsed() < ACK_TIMEOUT
}
fn on_drawn(app: &AppHandle, ink: DrawnInk) -> Result<(), String> {
    let (target, generation, stored_card) = {
        let state = state(app)?;
        let s = state.0.lock().unwrap_or_else(|p| p.into_inner());
        let t = s
            .turn
            .as_ref()
            .filter(|t| accept_ack(t, &ink))
            .ok_or("Stale ink acknowledgment.")?;
        (t.target.clone(), t.generation, t.stored_card)
    };
    if !(capture_session::is_target_current(app, &target, generation)
        || (stored_card && stored_target_current(app, &target, generation)))
    {
        return Err("The ink target changed.".into());
    }
    let pill = {
        let state = state(app)?;
        let mut s = state.0.lock().unwrap_or_else(|p| p.into_inner());
        let t = s
            .turn
            .as_mut()
            .filter(|t| accept_ack(t, &ink))
            .ok_or("Stale ink acknowledgment.")?;
        let monitor = ScreenRect {
            left: 0,
            top: 0,
            right: t.display.pixel_width as i32,
            bottom: t.display.pixel_height as i32,
        };
        let ink = ink::check_drawn(ink, monitor).ok_or("Invalid ink acknowledgment.")?;
        let bbox = ink.bbox;
        t.drawn = Some(to_image(ink, t));
        if t.coaching || t.frame.is_none() {
            None
        } else {
            bbox.map(|b| (t.id, t.display, b))
        }
    };
    if let Some((id, display, bbox)) = pill {
        show_pill(app, id, display, bbox)?;
    }
    Ok(())
}
fn show_pill(app: &AppHandle, id: u64, display: Display, bbox: ink::Rect) -> Result<(), String> {
    let rect = ScreenRect {
        left: bbox[0].floor() as i32,
        top: bbox[1].floor() as i32,
        right: (bbox[0] + bbox[2]).ceil() as i32,
        bottom: (bbox[1] + bbox[3]).ceil() as i32,
    };
    let local = ink_pill_spot(rect, display);
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        if !state(&app2).ok().is_some_and(|s| {
            s.0.lock()
                .unwrap_or_else(|p| p.into_inner())
                .turn
                .as_ref()
                .is_some_and(|t| t.id == id && t.faded_at.is_none() && t.frame.is_some())
        }) {
            return;
        }
        if let Ok(w) = overlay::ensure(&app2, Surface::Pill) {
            let _ = overlay::place(&w, local);
            let _ = overlay::dispatch(&app2, Surface::Pill, "mew:pill-show", &json!({}));
            let _ = overlay::show_quietly(&w);
        }
    })
    .map_err(|_| "Couldn't show the ink pill.".into())
}
fn ink_pill_spot(rect: ScreenRect, display: Display) -> Rect {
    let monitor = ScreenRect {
        left: 0,
        top: 0,
        right: display.pixel_width as i32,
        bottom: display.pixel_height as i32,
    };
    let p = crate::screen::surfaces::pill_spot(rect, monitor, display.scale_x());
    Rect::new(
        display.points.x + f64::from(p.left) / display.scale_x(),
        display.points.y + f64::from(p.top) / display.scale_y(),
        f64::from(p.width()) / display.scale_x(),
        f64::from(p.height()) / display.scale_y(),
    )
    .unwrap_or(display.points)
}
pub fn take_for_save(
    app: &AppHandle,
) -> Result<(Arc<NativeFrame>, Vec<ScreenAction>, DrawnInk), String> {
    // Inspect without consuming: a stale frame still holds the anchor needed for re-placement,
    // and a renderer acknowledgment must be able to arrive while Save is waiting.
    let (id, frame) = {
        let managed = state(app)?;
        let s = managed.0.lock().unwrap_or_else(|p| p.into_inner());
        let turn = s.turn.as_ref().ok_or("There is no ink to save.")?;
        if turn.faded_at.is_some() || turn.expires_at <= Instant::now() {
            return Err("The annotated frame has expired.".into());
        }
        if turn.drawn.is_none() {
            return Err("The ink has not finished drawing.".into());
        }
        (
            turn.id,
            turn.frame
                .clone()
                .ok_or("This answer has no retained capture to save.")?,
        )
    };
    if !capture_session::is_current(app, &frame) {
        return Err("The annotated frame is no longer current.".into());
    }
    let turn = {
        let managed = state(app)?;
        let mut s = managed.0.lock().unwrap_or_else(|p| p.into_inner());
        if s.turn.as_ref().is_none_or(|t| {
            t.id != id
                || t.faded_at.is_some()
                || t.expires_at <= Instant::now()
                || t.drawn.is_none()
        }) {
            return Err("The ink changed before Save.".into());
        }
        s.turn.take().ok_or("The ink was cleared.")?
    };
    hide(app, CLEAR);
    native_watch::stop(app, turn.id);
    crate::mac_shortcut::release_escape(app);
    Ok((
        frame,
        turn.actions,
        turn.drawn.ok_or("The ink has not finished drawing.")?,
    ))
}

fn only_pill_click(
    before: capture_session::ContentStamp,
    after: capture_session::ContentStamp,
) -> bool {
    before.0[0] == after.0[0]
        && before.0[1] == after.0[1]
        && before.0[3] == after.0[3]
        && after.0[2].wrapping_sub(before.0[2]) == 1
}

fn pointer_on_pill(app: &AppHandle, id: u64) -> bool {
    let Some(point) = super::input::cursor() else {
        return false;
    };
    let Ok(state) = state(app) else {
        return false;
    };
    let s = state.0.lock().unwrap_or_else(|p| p.into_inner());
    let Some(t) = s.turn.as_ref().filter(|t| t.id == id && t.frame.is_some()) else {
        return false;
    };
    let Some(ink) = &t.drawn else {
        return false;
    };
    let Some(b) = ink.bbox else {
        return false;
    };
    // Drawn ink is stored in image pixels; map back to display backing pixels solely for
    // the known native pill geometry. A click there saves this exact existing frame.
    let f = t.request.frame;
    let sx = f[2] / t.capture_pixels.0 as f32;
    let sy = f[3] / t.capture_pixels.1 as f32;
    let bbox = [f[0] + b[0] * sx, f[1] + b[1] * sy, b[2] * sx, b[3] * sy];
    let r = ScreenRect {
        left: bbox[0] as i32,
        top: bbox[1] as i32,
        right: (bbox[0] + bbox[2]) as i32,
        bottom: (bbox[1] + bbox[3]) as i32,
    };
    ink_pill_spot(r, t.display).contains(point)
}
fn anchor_for_frame(
    frame: &NativeFrame,
    actions: &[ScreenAction],
    rules: &crate::screen::privacy::detect::RedactionRules,
) -> (Option<TextAnchor>, SecretBytes, FocusKind) {
    let focus = actions.iter().find_map(|a| match a {
        ScreenAction::FocusRegion { region, kind } => Some((*region, *kind)),
        _ => None,
    });
    let Some((b, kind)) = focus else {
        return (None, SecretBytes::from_vec(Vec::new()), FocusKind::Text);
    };
    let (w, h) = frame.captured.metadata.captured_pixels;
    let r = ScreenRect {
        left: (u32::from(b.left) * w / 1000) as i32,
        top: (u32::from(b.top) * h / 1000) as i32,
        right: (u32::from(b.right) * w / 1000) as i32,
        bottom: (u32::from(b.bottom) * h / 1000) as i32,
    };
    let text = frame.text().text_in(r, rules);
    (
        frame.text().anchor_in(r),
        SecretBytes::from_vec(text.into_bytes()),
        kind,
    )
}
/// Dispatch one fresh explicit request; never reuse faded pixels. Reanchor uses local OCR
/// first, then the existing authenticated model route with exactly the earlier ink words.
pub fn reannotate(app: &AppHandle) -> Result<(), String> {
    let app = app.clone();
    std::thread::Builder::new()
        .name("neb-mac-reanchor".into())
        .spawn(move || {
            if let Err(message) = reannotate_now(&app) {
                crate::screen::page::dispatch(
                    &app,
                    crate::screen::page::SAY,
                    json!({"text":message}),
                );
            }
        })
        .map_err(|_| "Couldn't start re-placing tutor ink.")?;
    Ok(())
}
fn same_ink(previous: &[ScreenAction], moved: &[ScreenAction]) -> bool {
    previous.len() == moved.len()
        && previous.iter().zip(moved).all(|(a, b)| {
            std::mem::discriminant(a) == std::mem::discriminant(b) && a.texts() == b.texts()
        })
}
fn reannotate_now(app: &AppHandle) -> Result<(), String> {
    let (origin_id, seed, actions, anchor, kind, text, old_bounds, coaching) = {
        let state = state(app)?;
        let s = state.0.lock().unwrap_or_else(|p| p.into_inner());
        let t = s
            .turn
            .as_ref()
            .filter(|t| {
                t.faded_at
                    .is_none_or(|when| when.elapsed() < KEEP_AFTER_FADE)
            })
            .ok_or("There is no recent ink to show again.")?;
        (
            t.id,
            t.seed.clone(),
            t.actions.clone(),
            t.anchor.clone(),
            t.focus_kind,
            SecretBytes::from_vec(t.focus_text.as_slice().to_vec()),
            ScreenRect {
                left: 0,
                top: 0,
                right: t.capture_pixels.0 as i32,
                bottom: t.capture_pixels.1 as i32,
            },
            t.coaching,
        )
    };
    let stamp = super::service_call::credential_stamp(app).map_err(|e| e.to_string())?;
    let generation = runtime::of(app)?
        .generation
        .load(std::sync::atomic::Ordering::Acquire);
    let frame = capture_session::capture_window(app, super::pipeline::Intent::Ask, generation)?;
    let meta = frame.server_meta();
    let moved = anchor.as_ref().and_then(|a| {
        frame
            .text()
            .locate(a)
            .and_then(|now| ink::move_actions(&actions, old_bounds, meta.bounds, a.rect, now))
    });
    let moved = match moved {
        Some(moved) => moved,
        None => {
            let cancelled = || {
                !capture_session::is_current(app, &frame)
                    || super::service_call::credential_stamp(app).ok() != Some(stamp)
            };
            let body = protocol::reanchor_body(
                &meta,
                kind,
                std::str::from_utf8(text.as_slice()).unwrap_or(""),
                &actions,
                frame.captured.jpeg.as_slice(),
            );
            let reply = super::service_call::post_bound(
                app,
                "api/screen/reanchor",
                body.as_slice(),
                &stamp,
                &cancelled,
            )
            .map_err(|e| e.to_string())?;
            let response = protocol::parse_reanchor(reply.as_slice())
                .filter(|r| r.found && same_ink(&actions, &r.actions))
                .ok_or("I couldn't find the same content. Ask about your screen again.")?;
            response.actions
        }
    };
    if !capture_session::is_current(app, &frame)
        || super::service_call::credential_stamp(app).ok() != Some(stamp)
    {
        return Err("The re-placed ink was cancelled.".into());
    }
    if state(app)?
        .0
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .turn
        .as_ref()
        .is_none_or(|t| t.id != origin_id)
    {
        return Err("The earlier ink was cleared.".into());
    }
    show_owned_actions(app, frame, &seed, moved, coaching)
}

fn stored_target_current(app: &AppHandle, target: &Target, generation: u64) -> bool {
    let target = target.clone();
    let handle = app.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let deadline = Instant::now() + Duration::from_millis(450);
    if app
        .run_on_main_thread(move || {
            if Instant::now() < deadline {
                let _ = tx.send(capture_session::stored_target_current_main(
                    &handle, &target, generation,
                ));
            }
        })
        .is_err()
    {
        return false;
    }
    rx.recv_timeout(Duration::from_millis(450)).unwrap_or(false)
}
/// Clone only the bounded vector ink, never pixels or OCR strings. Bind it to the exact frame.
pub fn drawn_for_frame(app: &AppHandle, frame: &NativeFrame) -> Option<DrawnInk> {
    let state = state(app).ok()?;
    let s = state.0.lock().ok()?;
    let t = s.turn.as_ref()?;
    (t.target == frame.target
        && t.generation == frame.generation
        && t.capture_pixels == frame.captured.metadata.captured_pixels
        && t.expires_at == frame.expires_at()
        && t.faded_at.is_none()
        && Instant::now() < t.expires_at)
        .then(|| t.drawn.clone())
        .flatten()
}

#[tauri::command]
pub async fn screen_ink_ready(window: WebviewWindow) -> Result<(), String> {
    overlay::require_surface(&window, Surface::Ink)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let active = {
            let state = state(&app)?;
            let mut s = state.0.lock().unwrap_or_else(|p| p.into_inner());
            s.ready = true;
            s.turn
                .as_ref()
                .filter(|t| t.faded_at.is_none())
                .map(|t| (t.id, t.target.clone(), t.generation, t.stored_card))
        };
        if let Some((id, target, generation, stored_card)) = active {
            if capture_session::is_target_current(&app, &target, generation)
                || (stored_card && stored_target_current(&app, &target, generation))
            {
                dispatch_pending(&app, id)?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|_| "Ink readiness was interrupted.".to_owned())?
}
#[tauri::command]
pub async fn screen_ink_drawn(window: WebviewWindow, ink: DrawnInk) -> Result<(), String> {
    overlay::require_surface(&window, Surface::Ink)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || on_drawn(&app, ink))
        .await
        .map_err(|_| "Ink acknowledgment was interrupted.".to_owned())?
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PillAction {
    Save,
    Clear,
}
#[tauri::command]
pub async fn screen_ink_pill(window: WebviewWindow, action: PillAction) -> Result<(), String> {
    overlay::require_surface(&window, Surface::Pill)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || match action {
        PillAction::Clear => clear(&app),
        PillAction::Save => {
            let handler = state(&app)?
                .0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .save
                .clone()
                .ok_or("Saving tutor ink is not connected.")?;
            handler(app)
        }
    })
    .await
    .map_err(|_| "The ink action was interrupted.".to_owned())?
}

/// An explicit Save may outlive its earlier screenshot. Re-place the same ink on a newly
/// authorized/redacted frame, then wait only for the bundled renderer's bounded acknowledgement.
pub fn prepare_save(
    app: &AppHandle,
) -> Result<(Arc<NativeFrame>, Vec<ScreenAction>, DrawnInk), String> {
    if let Ok(saved) = take_for_save(app) {
        return Ok(saved);
    }
    reannotate_now(app)?;
    let id = state(app)?
        .0
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .turn
        .as_ref()
        .map(|t| t.id)
        .ok_or("The ink was cleared.")?;
    let until = Instant::now() + ACK_TIMEOUT;
    while Instant::now() < until {
        if let Ok(saved) = take_for_save(app) {
            return Ok(saved);
        }
        if !state(app)?
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .turn
            .as_ref()
            .is_some_and(|t| t.id == id && t.faded_at.is_none())
        {
            return Err("The ink changed before it could be saved.".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err("The ink renderer didn't acknowledge this clip. Try again.".into())
}

pub fn has_recent(app: &AppHandle) -> bool {
    state(app).is_ok_and(|s| {
        s.0.lock()
            .unwrap_or_else(|p| p.into_inner())
            .turn
            .as_ref()
            .is_some_and(|t| {
                t.faded_at
                    .is_none_or(|when| when.elapsed() < KEEP_AFTER_FADE)
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::ink::{InkColors, InkStroke, InkTool};
    fn request() -> InkRequest {
        InkRequest {
            id: 1,
            seed: "fixture".into(),
            actions: Vec::new(),
            frame: [0., 0., 2000., 1000.],
            bounds: [0., 0., 2000., 1000.],
            obstacles: vec![[20., 10., 100., 20.]],
            text_height: Some(20.),
            scale: 1.,
            colors: InkColors {
                ink: "#6b4ee6".into(),
                highlight: "#6b4ee655".into(),
                question: "#d97706".into(),
            },
            animate: false,
            step: None,
            fly_from: None,
        }
    }
    fn display() -> Display {
        Display::new(
            1,
            Rect::new(-1440., -200., 1440., 900.).unwrap(),
            2880,
            1800,
        )
        .unwrap()
    }
    fn turn() -> Turn {
        let target = Target {
            window_id: 99,
            process: super::super::privacy::ProcessIdentity {
                pid: 42,
                bundle_id: "com.apple.TextEdit".into(),
                launch_time_bits: 1000f64.to_bits(),
            },
            quartz_points: Rect::new(-1390., -180., 1000., 500.).unwrap(),
        };
        Turn {
            id: 1,
            target: target.clone(),
            generation: 7,
            expires_at: Instant::now() + Duration::from_secs(60),
            shown_at: Instant::now(),
            display: display(),
            capture_pixels: (2000, 1000),
            capture_area: target.quartz_points,
            actions: Vec::new(),
            seed: "fixture".into(),
            request: transform_request(request(), target.quartz_points, display(), (2000, 1000))
                .unwrap(),
            drawn: None,
            frame: None,
            coaching: false,
            faded_at: None,
            stored_card: false,
            anchor: None,
            focus_text: SecretBytes::from_vec(Vec::new()),
            focus_kind: FocusKind::Text,
            content_stamp: capture_session::ContentStamp([0; 4]),
            native_content_watch: false,
        }
    }
    fn drawn() -> DrawnInk {
        DrawnInk {
            id: 1,
            strokes: vec![InkStroke {
                tool: InkTool::Pen,
                color: "#6b4ee6".into(),
                width: 4.,
                points: vec![[120., 50., 0.5, 0.], [220., 70., 1., 10.]],
            }],
            cards: vec![[120., 50., 100., 20.]],
            bbox: Some([120., 50., 100., 20.]),
            step: None,
        }
    }
    #[test]
    fn retina_negative_origin_is_display_local_not_global() {
        let t = turn();
        assert_eq!(t.request.frame, [100., 40., 2000., 1000.]);
        assert_eq!(t.request.bounds, [0., 0., 2880., 1800.]);
        assert_eq!(t.request.obstacles, vec![[120., 50., 100., 20.]]);
        assert_eq!(t.request.scale, 2.);
        assert_eq!(t.request.text_height, Some(20.));
        let value = serde_json::to_value(&t.request).unwrap();
        assert!(value.get("text").is_none());
        assert!(value.get("words").is_none());
    }
    #[test]
    fn vector_ack_maps_back_to_the_exact_original_capture() {
        let actual = to_image(drawn(), &turn());
        assert_eq!(
            actual.strokes[0].points,
            vec![[20., 10., 0.5, 0.], [120., 30., 1., 10.]]
        );
        assert_eq!(actual.cards, vec![[20., 10., 100., 20.]]);
        assert_eq!(actual.bbox, Some([20., 10., 100., 20.]));
        assert_eq!(actual.strokes[0].width, 4.);
    }
    #[test]
    fn stale_replayed_or_unrequested_step_ack_cannot_attach() {
        let mut turn = turn();
        let mut ack = drawn();
        assert!(accept_ack(&turn, &ack));
        ack.id += 1;
        assert!(!accept_ack(&turn, &ack));
        ack.id = 1;
        ack.step = Some(1);
        assert!(!accept_ack(&turn, &ack));
        ack.step = None;
        turn.drawn = Some(ack.clone());
        assert!(!accept_ack(&turn, &ack));
        turn.drawn = None;
        turn.expires_at = Instant::now();
        assert!(!accept_ack(&turn, &ack));
        turn.expires_at = Instant::now() + Duration::from_secs(1);
        turn.shown_at = Instant::now() - ACK_TIMEOUT;
        assert!(!accept_ack(&turn, &ack));
        turn.shown_at = Instant::now();
        turn.faded_at = Some(Instant::now());
        assert!(!accept_ack(&turn, &ack));
    }
    #[test]
    fn malformed_ack_and_unsupported_display_scale_fail_closed() {
        let mut ack = drawn();
        ack.strokes[0].points[0][0] = f32::NAN;
        assert!(ink::check_drawn(
            ack,
            ScreenRect {
                left: 0,
                top: 0,
                right: 2880,
                bottom: 1800
            }
        )
        .is_none());
        let mut display = display();
        display.pixel_height = 900;
        assert!(transform_request(
            request(),
            turn().target.quartz_points,
            display,
            (2000, 1000)
        )
        .is_err());
        assert!(
            transform_request(request(), turn().target.quartz_points, display, (0, 1000)).is_err()
        );
    }
    #[test]
    fn local_notes_marks_are_valid_but_malformed_actions_are_not() {
        use crate::screen::protocol::Box2;
        assert!(validate_actions(&[ScreenAction::CheckMark {
            region: Box2 {
                left: 10,
                top: 20,
                right: 100,
                bottom: 200
            }
        }]));
        assert!(!validate_actions(&[ScreenAction::Underline {
            region: Box2 {
                left: 1001,
                top: 20,
                right: 2000,
                bottom: 200
            }
        }]));
        assert!(!validate_actions(&vec![ScreenAction::Clear; 25]));
    }
    #[test]
    fn reanchor_never_accepts_new_words_or_new_action_kinds() {
        let before = vec![ScreenAction::MarginNote {
            text: "Balance both sides".into(),
            beside: crate::screen::protocol::Box2 {
                left: 10,
                top: 10,
                right: 20,
                bottom: 20,
            },
            side: None,
        }];
        let moved = before
            .iter()
            .map(|a| a.map_coordinates(|x, y| (x + 10, y + 20)))
            .collect::<Vec<_>>();
        assert!(same_ink(&before, &moved));
        assert!(!same_ink(&before, &[ScreenAction::Clear]));
        let mut changed = moved;
        if let ScreenAction::MarginNote { text, .. } = &mut changed[0] {
            *text = "New instruction".into();
        }
        assert!(!same_ink(&before, &changed));
    }
    #[test]
    fn save_pill_click_exception_never_exempts_scroll_or_keyboard_changes() {
        use capture_session::ContentStamp;
        assert!(only_pill_click(
            ContentStamp([1, 2, 3, 4]),
            ContentStamp([1, 2, 4, 4])
        ));
        for after in [[2, 2, 4, 4], [1, 3, 4, 4], [1, 2, 5, 4], [1, 2, 4, 5]] {
            assert!(!only_pill_click(
                ContentStamp([1, 2, 3, 4]),
                ContentStamp(after)
            ));
        }
    }
}
