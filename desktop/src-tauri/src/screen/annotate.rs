//! Ink on the student's screen (S3 §2): from a reply's actions to ink beside the content, kept
//! attached to it, and re-placed on request.
//!
//! 1. `show`: the overlay is moved onto the capture's monitor and asked to draw (it gets the
//!    actions and the on-screen text as rectangles). The target window is watched from now on.
//! 2. `on_drawn`: the overlay reports the strokes it drew; the pill appears beside them.
//! 3. `faded`: the content moved (scroll, move, app switch…): the ink fades, the screenshot is
//!    wiped, and the actions are kept for two minutes so "show that again" can re-place them.
//! 4. `reannotate`: a new capture; the focus region's text is looked for on it (on the device),
//!    then the server is asked (only if that failed), and the same ink is drawn again.
//!
//! The held screenshot (needed to clip) lives only while its ink is on screen and unchanged, and
//! at most `MAX_VISIBLE`. Esc clears everything.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut};

use super::coach::{self, ScreenCoach};
use super::frame::{FrameDetail, FrameMeta, ScreenRect};
use super::ink::{self, check_drawn, DrawnInk};
use super::overlay::{self, Surface};
use super::page;
use super::pipeline::Captured;
use super::protocol::{Box2, FocusKind, ScreenAction};
use super::screen_text::TextAnchor;
use super::win::winevent::{self, Watch};
use super::{clip, reanchor, watch::Change};

/// Ink (and the screenshot under it) never stays longer than this, even if nothing moves.
const MAX_VISIBLE: Duration = Duration::from_secs(5 * 60);
/// After fading, the actions are kept this long for "show that again" (brief §2.3).
const KEEP_AFTER_FADE: Duration = Duration::from_secs(2 * 60);

/// Overlay page events (desktop/overlay-src/ink-overlay.ts).
const DRAW: &str = "mew:ink-draw";
const FADE: &str = "mew:ink-fade";
const CLEAR: &str = "mew:ink-clear";
/// Pill page events (desktop/overlay-src/ink-pill.ts).
const PILL_SHOW: &str = "mew:pill-show";

#[derive(Default)]
pub struct InkState {
    next_id: u64,
    turn: Option<InkTurn>,
    watch: Option<Watch>,
}

/// Esc is registered as a global hotkey (only while ink is visible). Changed outside the ink
/// lock: registering talks to the main thread, whose Esc handler takes that lock.
static ESCAPE_ON: AtomicBool = AtomicBool::new(false);

/// The last annotated answer.
pub struct InkTurn {
    pub id: u64,
    pub seed: String,
    pub actions: Vec<ScreenAction>,
    pub focus: Option<(Box2, FocusKind)>,
    /// A few words of the focus region and where they were (to find it again on the device).
    pub anchor: Option<TextAnchor>,
    /// The focus region's text, for the server when the device can't find it (wiped on drop).
    pub focus_text: String,
    pub meta: FrameMeta,
    pub video_time_sec: Option<u32>,
    /// The screenshot the ink was drawn for; None once the screen changed.
    pub frame: Option<FrameDetail>,
    pub drawn: Option<DrawnInk>,
    pub visible: bool,
    /// Drawn for a walkthrough: no Esc, no ink pill.
    pub coaching: bool,
    pub shown_at: Instant,
    pub faded_at: Option<Instant>,
    /// Open the clip preview as soon as the overlay reports this drawing ("save this" after the
    /// page moved).
    pub clip_when_drawn: bool,
}

impl Drop for InkTurn {
    fn drop(&mut self) {
        let mut bytes = std::mem::take(&mut self.focus_text).into_bytes();
        super::secret::wipe(&mut bytes);
    }
}

/// What there is to save or re-place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnState {
    None,
    /// On screen and unchanged: the held screenshot can be clipped at once.
    Live,
    /// Faded (or never drawn): the actions are known, the screenshot is gone.
    Stale,
}

/// A reply's ink, ready to show.
pub struct ShowInk {
    pub seed: String,
    pub actions: Vec<ScreenAction>,
    pub meta: FrameMeta,
    pub detail: FrameDetail,
    pub video_time_sec: Option<u32>,
    pub clip_when_drawn: bool,
    /// A walkthrough's arrow (S4): Esc stays with the student's app (Excel and Word use it), and
    /// the progress pill shows instead of the ink pill.
    pub coaching: bool,
}

fn state<R: Runtime>(app: &AppHandle<R>) -> Option<std::sync::MutexGuard<'_, InkState>> {
    app.try_state::<ScreenCoach>()
        .map(|coach| coach.inner().ink())
}

pub fn turn_state<R: Runtime>(app: &AppHandle<R>) -> TurnState {
    let Some(mut state) = state(app) else {
        return TurnState::None;
    };
    expire(&mut state, Instant::now());
    match &state.turn {
        None => TurnState::None,
        Some(turn) if turn.visible && turn.frame.is_some() && turn.drawn.is_some() => {
            TurnState::Live
        }
        Some(_) => TurnState::Stale,
    }
}

/// Draws a reply's ink. A reply without ink clears whatever was there (it was about something
/// else). Call off the main thread.
pub fn show<R: Runtime>(app: &AppHandle<R>, ink_to_show: ShowInk) {
    let ShowInk {
        seed,
        actions,
        meta,
        detail,
        video_time_sec,
        clip_when_drawn,
        coaching,
    } = ink_to_show;
    let draws = actions
        .iter()
        .any(|a| !matches!(a, ScreenAction::FocusRegion { .. } | ScreenAction::Clear));
    if !draws {
        clear(app);
        return;
    }
    let Some(window) = meta
        .window
        .map(|raw| windows::Win32::Foundation::HWND(raw as *mut _))
    else {
        return;
    };
    // Warm the windows this ink may need (creating one takes a few hundred milliseconds).
    let Some(overlay_window) = overlay::ensure(app, Surface::Ink) else {
        return;
    };
    if !coaching {
        let _ = overlay::ensure(app, Surface::Pill);
        let _ = overlay::ensure(app, Surface::Clip);
    }

    let focus = actions.iter().find_map(|a| match a {
        ScreenAction::FocusRegion { region, kind } => Some((*region, *kind)),
        _ => None,
    });
    let focus_screen = focus.map(|(region, _)| to_screen(region, meta.bounds));
    let rules = app
        .try_state::<ScreenCoach>()
        .map(|coach| coach.privacy().redaction)
        .unwrap_or_default();
    let anchor = focus_screen.and_then(|rect| detail.text.anchor_in(rect));
    let focus_text = focus_screen
        .map(|rect| detail.text.text_in(rect, &rules))
        .unwrap_or_default();

    let Some(mut state) = state(app) else {
        return;
    };
    // The ink only makes sense while the content stays put: watch first, and don't show ink
    // that couldn't be faded when it goes stale.
    state.watch = None;
    let handle = app.clone();
    let id = {
        state.next_id += 1;
        state.next_id
    };
    let Some(new_watch) = winevent::start(window, move |change| faded(&handle, id, change)) else {
        eprintln!("[screen] couldn't watch the window; not drawing ink");
        state.turn = None;
        return;
    };
    state.watch = Some(new_watch);

    let request = ink::ink_request(
        id,
        &seed,
        &actions,
        &meta,
        &detail.text,
        super::win::system::animations_enabled(),
        super::win::system::contrast_highlight().as_deref(),
    );
    state.turn = Some(InkTurn {
        id,
        seed,
        actions,
        focus,
        anchor,
        focus_text,
        meta: meta.clone(),
        video_time_sec,
        frame: Some(detail),
        drawn: None,
        visible: true,
        coaching,
        shown_at: Instant::now(),
        faded_at: None,
        clip_when_drawn,
    });
    drop(state);
    set_escape(app, !coaching);

    overlay::hide_quietly_named(app, Surface::Pill);
    overlay::place(&overlay_window, meta.monitor);
    overlay::show_quietly(&overlay_window);
    let detail = serde_json::to_value(&request).unwrap_or_default();
    overlay::dispatch(app, Surface::Ink, DRAW, &detail);
    schedule_max_visible(app, id);
}

/// The overlay drew request `ink.id`: keep its strokes (checked) and show the pill beside them.
pub fn on_drawn<R: Runtime>(app: &AppHandle<R>, ink: DrawnInk) {
    let Some(mut state) = state(app) else {
        return;
    };
    let Some(turn) = state.turn.as_mut().filter(|t| t.id == ink.id && t.visible) else {
        return;
    };
    let Some(ink) = check_drawn(ink, turn.meta.monitor) else {
        eprintln!("[screen] the overlay reported ink out of bounds; ignored");
        return;
    };
    let scale = f64::from(turn.meta.dpi.max(96)) / 96.0;
    let monitor = turn.meta.monitor;
    let ink_rect = ink.bbox.map(|[x, y, w, h]| ScreenRect {
        left: monitor.left + x as i32,
        top: monitor.top + y as i32,
        right: monitor.left + (x + w) as i32,
        bottom: monitor.top + (y + h) as i32,
    });
    turn.drawn = Some(ink);
    let clip_now = std::mem::take(&mut turn.clip_when_drawn);
    let coaching = turn.coaching;
    drop(state);

    if clip_now {
        clip::from_ink(app);
        return;
    }
    if coaching {
        return; // the progress pill is showing instead
    }
    if let (Some(rect), Some(pill)) = (ink_rect, app.get_webview_window(Surface::Pill.label())) {
        overlay::place(&pill, overlay::pill_spot(rect, monitor, scale));
        overlay::dispatch(app, Surface::Pill, PILL_SHOW, &json!({}));
        overlay::show_quietly(&pill);
    }
}

/// The content under ink `id` may have moved: fade it, wipe the screenshot, keep the actions.
fn faded<R: Runtime>(app: &AppHandle<R>, id: u64, change: Change) {
    {
        let Some(mut state) = state(app) else {
            return;
        };
        let Some(turn) = state.turn.as_mut().filter(|t| t.id == id && t.visible) else {
            return;
        };
        turn.visible = false;
        turn.frame = None;
        turn.faded_at = Some(Instant::now());
        state.watch = None;
    }
    set_escape(app, false);
    eprintln!("[screen] ink faded ({change:?})");
    overlay::dispatch(app, Surface::Ink, FADE, &json!({}));
    overlay::hide_quietly_named(app, Surface::Pill);
    let handle = app.clone();
    let _ = std::thread::Builder::new()
        .name("mew-ink-expiry".into())
        .spawn(move || {
            std::thread::sleep(KEEP_AFTER_FADE);
            if let Some(mut state) = state(&handle) {
                expire(&mut state, Instant::now());
            }
        });
}

/// Hides the ink and forgets it (Esc, the pill's Clear, pausing, turning Screen Coach off).
pub fn clear<R: Runtime>(app: &AppHandle<R>) {
    if let Some(mut state) = state(app) {
        state.turn = None;
        state.watch = None;
    }
    set_escape(app, false);
    overlay::dispatch(app, Surface::Ink, CLEAR, &json!({}));
    overlay::hide_quietly_named(app, Surface::Ink);
    overlay::hide_quietly_named(app, Surface::Pill);
}

/// Takes the live turn's screenshot and ink for a clip (the ink is cleared from the screen: the
/// preview shows it instead). None unless the turn is live.
pub fn take_for_clip<R: Runtime>(app: &AppHandle<R>) -> Option<InkTurn> {
    let turn = {
        let mut state = state(app)?;
        expire(&mut state, Instant::now());
        let live = state
            .turn
            .as_ref()
            .is_some_and(|t| t.visible && t.frame.is_some() && t.drawn.is_some());
        if !live {
            return None;
        }
        state.watch = None;
        state.turn.take()?
    };
    set_escape(app, false);
    overlay::dispatch(app, Surface::Ink, CLEAR, &json!({}));
    overlay::hide_quietly_named(app, Surface::Ink);
    overlay::hide_quietly_named(app, Surface::Pill);
    Some(turn)
}

/// "Show that again" (or "save this" after the page moved, with `then_clip`): re-places the
/// last ink on a new capture. Runs off the main thread (it may ask the server).
pub fn reannotate<R: Runtime>(app: &AppHandle<R>, captured: Captured, then_clip: bool) {
    let previous = {
        let Some(mut state) = state(app) else {
            return;
        };
        expire(&mut state, Instant::now());
        state.turn.as_ref().map(|turn| {
            (
                turn.seed.clone(),
                turn.actions.clone(),
                turn.meta.bounds,
                turn.anchor.clone(),
                turn.focus.map(|(_, kind)| kind),
                turn.focus_text.clone(),
                turn.video_time_sec,
                turn.coaching,
            )
        })
    };
    let Some((seed, actions, old_bounds, anchor, kind, mut focus_text, video_time_sec, coaching)) =
        previous
    else {
        say(
            app,
            "There's nothing to show again yet. Ask me about your screen first.",
        );
        return;
    };

    // On the device first: the same words, where they are now.
    let moved = anchor.as_ref().and_then(|anchor| {
        let now = captured.detail.text.locate(anchor)?;
        ink::move_actions(&actions, old_bounds, captured.meta.bounds, anchor.rect, now)
    });
    // Then the server, with the new screenshot (only when the device couldn't find it).
    let moved = moved.or_else(|| {
        reanchor::ask_server(
            app,
            &captured,
            kind.unwrap_or(FocusKind::Text),
            &focus_text,
            &actions,
        )
    });
    super::account::wipe_string(&mut focus_text);

    match moved {
        Some(actions) => show(
            app,
            ShowInk {
                seed,
                actions,
                meta: captured.meta,
                detail: captured.detail,
                video_time_sec,
                clip_when_drawn: then_clip,
                coaching,
            },
        ),
        None => say(
            app,
            "I can't find that part on your screen any more. Scroll back to it, or ask me again.",
        ),
    }
}

/// Tells the student something out loud (the page speaks it), as a short reply.
fn say<R: Runtime>(app: &AppHandle<R>, text: &str) {
    page::dispatch(app, page::SPEECH, json!({ "text": text }));
}

/// The turn as normalised boxes → its screen rectangle.
fn to_screen(region: Box2, bounds: ScreenRect) -> ScreenRect {
    let x = |v: u16| bounds.left + (i64::from(v) * i64::from(bounds.width()) / 1000) as i32;
    let y = |v: u16| bounds.top + (i64::from(v) * i64::from(bounds.height()) / 1000) as i32;
    ScreenRect {
        left: x(region.left),
        top: y(region.top),
        right: x(region.right),
        bottom: y(region.bottom),
    }
}

/// Wipes a screenshot held too long, and forgets actions faded too long ago.
fn expire(state: &mut InkState, now: Instant) {
    let Some(turn) = state.turn.as_mut() else {
        return;
    };
    if turn.faded_at.is_some_and(|at| now >= at + KEEP_AFTER_FADE) {
        state.turn = None;
        return;
    }
    if turn.frame.is_some() && now >= turn.shown_at + MAX_VISIBLE {
        turn.frame = None;
    }
}

fn schedule_max_visible<R: Runtime>(app: &AppHandle<R>, id: u64) {
    let handle = app.clone();
    let _ = std::thread::Builder::new()
        .name("mew-ink-timeout".into())
        .spawn(move || {
            std::thread::sleep(MAX_VISIBLE);
            let still_showing = state(&handle)
                .is_some_and(|s| s.turn.as_ref().is_some_and(|t| t.id == id && t.visible));
            if still_showing {
                faded(&handle, id, Change::Moved);
            }
        });
}

/// Esc clears the ink, registered only while ink is visible (brief §4.3).
pub fn escape() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

/// Registers or unregisters Esc. Never call with the ink lock held (see `ESCAPE_ON`).
fn set_escape<R: Runtime>(app: &AppHandle<R>, on: bool) {
    if ESCAPE_ON.swap(on, Ordering::SeqCst) == on {
        return;
    }
    let shortcuts = app.global_shortcut();
    let result = if on {
        shortcuts.register(escape())
    } else {
        shortcuts.unregister(escape())
    };
    if result.is_err() && on {
        // Another app owns Esc as a global hotkey: the pill's Clear still works.
        ESCAPE_ON.store(false, Ordering::SeqCst);
    }
}

// ─── Commands for the overlay pages ──────────────────────────────────────────────────────────

/// The ink overlay reports what it drew.
#[tauri::command(async)]
pub fn screen_ink_drawn<R: Runtime>(window: WebviewWindow<R>, ink: DrawnInk) -> Result<(), String> {
    overlay::require_surface(&window, Surface::Ink)?;
    on_drawn(window.app_handle(), ink);
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PillAction {
    Save,
    Clear,
}

/// The pill's buttons.
#[tauri::command(async)]
pub fn screen_ink_pill<R: Runtime>(
    window: WebviewWindow<R>,
    action: PillAction,
) -> Result<(), String> {
    overlay::require_surface(&window, Surface::Pill)?;
    let app = window.app_handle();
    match action {
        PillAction::Save => clip::from_ink(app),
        PillAction::Clear => clear(app),
    }
    coach::refresh(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_a_focus_region_onto_the_screen() {
        let bounds = ScreenRect {
            left: -2000,
            top: 100,
            right: 0,
            bottom: 1100,
        };
        let region = Box2 {
            left: 250,
            top: 0,
            right: 500,
            bottom: 1000,
        };
        assert_eq!(
            to_screen(region, bounds),
            ScreenRect {
                left: -1500,
                top: 100,
                right: -1000,
                bottom: 1100
            }
        );
    }
}
