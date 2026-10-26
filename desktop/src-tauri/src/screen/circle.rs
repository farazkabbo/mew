//! Circle & Ask on the desktop (S3.2, docs/SCREEN_COACH_S3_2.md and decision 11): the student
//! draws around something on their screen, asks about it, and the tutor explains it with ink.
//!
//! This module holds a **session** (one set of marks, its capture, its questions) and everything
//! up to asking:
//! 1. A tracker thread (`run_tracker`) follows the cursor with the pointer. The hold gesture
//!    (left Ctrl + left Alt held, polled by `keys.rs`: decision 11, K2) or a double tap of them
//!    turns draw mode on: the draw overlay takes the mouse, pen and touch.
//! 2. The first mark starts a session: the privacy checks run as drawing begins; when the mark is
//!    finished, the monitor under it is captured once (the usual pipeline: blocked windows
//!    blacked out, redaction) and watched, so the marks fade if the content moves.
//! 3. Each mark is understood on the device (`marks.rs`) against the capture's text, and the ask
//!    bar (the card) appears beside the first one.
//! 4. The question (typed, said while holding the keys, read from the screen, or Enter) is sent
//!    with the marks by `circle_answer.rs`, which plays the explanation and saves it.
//!
//! Locks are never held across calls into a window (they may wait for the main thread).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

use super::circle_answer::{self, Answer};
use super::circle_protocol::{clean_question, Question};
use super::coach::{self, ScreenCoach};
use super::destination::save_to_phrase;
use super::drag::{Drag, DragLook};
use super::frame::ScreenRect;
use super::marks::{self, MarkKind, Pt, WordBox, MAX_MARKS};
use super::overlay::{self, require_surface, Surface};
use super::pipeline::Captured;
use super::pointer::{pointer_spot, shows, tick_ms, Hide, PointerLook};
use super::watch::Change;
use super::win::winevent::{self, Watch};
use super::win::{input, target};

/// Draw overlay page events (desktop/overlay-src/draw-overlay.ts).
const DRAW_SHOW: &str = "mew:draw-show";
const DRAW_FADE: &str = "mew:draw-fade";
/// The mouse stroke (or question box) being dragged, read by the tracker (`drag.rs`).
const DRAW_LIVE: &str = "mew:draw-live";
const DRAW_BOX: &str = "mew:draw-box";
/// Pointer page events (desktop/overlay-src/pointer.ts).
const POINTER_LOOK: &str = "mew:pointer-look";
/// Card page events (desktop/overlay-src/circle-card.ts).
pub(super) const CARD_SHOW: &str = "mew:card-show";

/// The ask bar closes after this long without input; the marks stay a minute longer (§2.3).
const ASK_IDLE: Duration = Duration::from_secs(20);
const MARKS_KEPT: Duration = Duration::from_secs(60);
/// How often the tracker checks what's in front (full screen, a blocked app, a call).
const HIDE_CHECK_EVERY: Duration = Duration::from_millis(500);
/// A cursor that moved within this time keeps the tracker at a frame per look.
const MOVING_FOR: Duration = Duration::from_millis(500);
/// How often the tracker looks while the mouse draws (smooth strokes).
const DRAG_TICK: Duration = Duration::from_millis(8);
/// A pen or touch stroke from the page this soon after a mouse drag is the same stroke.
const SAME_STROKE: Duration = Duration::from_millis(400);
/// A question box smaller than this (CSS pixels) is a slip.
const MIN_BOX: f32 = 8.0;

/// One student mark, in screen pixels.
pub(super) struct Mark {
    pub number: u8,
    pub kind: MarkKind,
    pub points: Vec<Pt>,
    /// The words it's about (indexes into the capture's words), once there's a capture.
    pub targets: Vec<usize>,
    pub region: Option<ScreenRect>,
}

/// Where a session is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Stage {
    /// Marks are being drawn; the ask bar shows after the first.
    Marking,
    /// A question is on its way, or its explanation is playing.
    Answering,
    /// The explanation ended; the toast (or the follow-up box) shows.
    Answered,
}

pub(super) struct Session {
    pub id: String,
    /// The monitor the marks are on, and its DPI.
    pub monitor: ScreenRect,
    pub dpi: u32,
    pub marks: Vec<Mark>,
    /// Why this app can't be looked at (marks turn grey), from the checks as drawing began.
    pub refused: Option<String>,
    /// The one capture (taken when the first mark was finished), until it's saved or discarded.
    pub capture: Option<Captured>,
    pub capturing: bool,
    pub watch: Option<Watch>,
    pub stage: Stage,
    pub last_input: Instant,
    /// The explanation in progress (or just played), and the earlier turns of this session.
    pub answer: Option<Answer>,
    pub history: Vec<super::circle_protocol::Turn>,
    /// The entry this session's turns are saved to (after the first save).
    pub entry: Option<circle_answer::SavedEntry>,
    /// A question asked before the capture was ready (Enter right after the first mark).
    pub pending: Option<Question>,
    /// Where this session's entry goes (K3): what the student said, the source's sticky place, or
    /// what they picked on the card. None: the notebook open in Neb.
    pub place: Option<super::destination::Place>,
    /// What the card offers to choose (K3): close candidates, a chapter to make, or the picker.
    pub place_offer: Option<circle_answer::PlaceOffer>,
    /// "Save this to …" with no explanation: the marks are saved once the place is chosen.
    pub save_only_pending: bool,
    /// The explanation was paused for the hold's words (K3: "save it to …" isn't barge-in).
    pub paused_for_words: bool,
    /// The card's last view (besides the picker), to go back to.
    pub last_view: Option<serde_json::Value>,
}

impl Session {
    pub fn scale(&self) -> f64 {
        f64::from(self.dpi.max(96)) / 96.0
    }
}

#[derive(Default)]
pub struct CircleState {
    /// The hold gesture is down (K2).
    hold: bool,
    /// The hold is listening (voice on): the pointer says so.
    listening: bool,
    /// A double tap turned draw mode on (pen and touch).
    draw_toggle: bool,
    /// Keyboard drawing (silent mode): the window that had the focus, to give it back.
    keyboard: Option<isize>,
    /// Draw mode is on right now (the keys or the toggle).
    drawing: bool,
    pub(super) session: Option<Session>,
    /// "Select question on screen": the next drag is a box around the question.
    selecting: bool,
    /// The mouse, read by the tracker while draw mode or selecting is on.
    drag: Drag,
    /// When the mouse last drew (to tell a pen stroke the page also saw from a new one).
    dragged_at: Option<Instant>,
    /// What the pointer shows.
    look: Option<PointerLook>,
    tracker_running: bool,
}

/// Esc is a global hotkey only while a session needs it (it'd take Esc from every app otherwise).
static KEYS_ON: AtomicBool = AtomicBool::new(false);

pub(super) fn state<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<std::sync::MutexGuard<'_, CircleState>> {
    app.try_state::<ScreenCoach>()
        .map(|coach| coach.inner().circle())
}

/// The session, changed under the lock (`None` if there is none).
pub(super) fn with_session<R: Runtime, T>(
    app: &AppHandle<R>,
    change: impl FnOnce(&mut Session) -> T,
) -> Option<T> {
    let mut state = state(app)?;
    state.session.as_mut().map(change)
}

// ─── The tracker ─────────────────────────────────────────────────────────────────────────────

/// Starts the tracker if Screen Coach is on and it isn't running (called whenever the settings
/// change). It ends itself when Screen Coach is off or paused.
pub fn start_tracker<R: Runtime>(app: &AppHandle<R>) {
    if !coach::is_usable(app) {
        return;
    }
    let already_running =
        state(app).is_none_or(|mut s| std::mem::replace(&mut s.tracker_running, true));
    if already_running {
        return;
    }
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("mew-pointer".into())
        .spawn(move || run_tracker(&handle));
    if spawned.is_err() {
        if let Some(mut state) = state(app) {
            state.tracker_running = false;
        }
    }
}

fn run_tracker<R: Runtime>(app: &AppHandle<R>) {
    let pointer = overlay::ensure(app, Surface::Pointer);
    let _ = overlay::ensure(app, Surface::Draw);
    let mut last_cursor = None;
    let mut moved_at = Instant::now() - MOVING_FOR;
    let mut hide = Hide::default();
    let mut hide_checked = Instant::now() - HIDE_CHECK_EVERY;
    let mut shown = false;

    while coach::is_usable(app) {
        let now = Instant::now();
        let drawing = state(app).map(|mut s| {
            // A stroke keeps draw mode on until it ends (the keys often come up first).
            let drawing = s.hold || s.draw_toggle || s.drag.active();
            let changed = drawing != s.drawing;
            s.drawing = drawing;
            (drawing, changed)
        });
        let Some((drawing, changed)) = drawing else {
            break;
        };
        if changed {
            set_drawing(app, drawing);
        }

        if now.duration_since(hide_checked) >= HIDE_CHECK_EVERY {
            hide = what_hides(&coach::privacy_of(app));
            hide_checked = now;
        }
        let settings = coach::circle_settings(app);
        let cursor = input::cursor();
        let dragging = track_drag(app, cursor);
        if cursor != last_cursor {
            moved_at = now;
            last_cursor = cursor;
        }
        if let (Some(window), Some((x, y))) = (&pointer, cursor) {
            let visible = shows(settings.pointer, drawing, hide);
            if visible {
                if let Some((monitor, dpi)) = target::monitor_at(x, y) {
                    let scale = f64::from(dpi.max(96)) / 96.0;
                    let spot = pointer_spot(
                        (x, y),
                        settings.pointer_size,
                        settings.pointer_corner,
                        scale,
                        monitor,
                    );
                    overlay::move_quickly(window, spot);
                }
            }
            if visible != shown {
                shown = visible;
                if visible {
                    overlay::show_quietly(window);
                } else {
                    overlay::hide_quietly(window);
                }
            }
        }
        update_look(app, drawing);
        circle_answer::tick(app, now);
        expire_session(app, now);

        let moving = now.duration_since(moved_at) < MOVING_FOR;
        std::thread::sleep(if dragging {
            DRAG_TICK
        } else {
            Duration::from_millis(tick_ms(moving, drawing))
        });
    }

    // Off or paused: nothing shows, nothing is held.
    if let Some(window) = &pointer {
        overlay::hide_quietly(window);
    }
    end_session(app);
    if let Some(mut state) = state(app) {
        state.tracker_running = false;
        state.hold = false;
        state.listening = false;
        state.drawing = false;
        state.draw_toggle = false;
        state.keyboard = None;
        state.selecting = false;
        state.drag.cancel();
    }
    set_drawing(app, false);
}

/// One look at the mouse (`drag.rs`) while draw mode or "select question" is on: shows the stroke
/// or box as it's dragged, and adds the mark (or asks about the box) when the button comes up.
/// True while a drag is in progress.
fn track_drag<R: Runtime>(app: &AppHandle<R>, cursor: Option<(i32, i32)>) -> bool {
    let down = input::primary_button_down();
    let (look, selecting, from) = {
        let Some(mut s) = state(app) else {
            return false;
        };
        let listening = (s.drawing && s.keyboard.is_none()) || s.selecting;
        let (Some((x, y)), true) = (cursor, listening) else {
            s.drag = Drag::new(down);
            return false;
        };
        let look = s.drag.look(down, (x as f32, y as f32));
        if look != DragLook::Idle {
            s.dragged_at = Some(Instant::now());
        }
        (look, s.selecting, s.drag.first())
    };
    let to_css = |points: &[Pt]| {
        with_session(app, |s| {
            let scale = s.scale() as f32;
            let (left, top) = (s.monitor.left as f32, s.monitor.top as f32);
            points
                .iter()
                .map(|(x, y)| [(x - left) / scale, (y - top) / scale])
                .collect::<Vec<_>>()
        })
    };
    let started = matches!(look, DragLook::Started(_));
    match look {
        DragLook::Idle => {}
        DragLook::Started(at) | DragLook::Moved(at) if selecting => {
            if let Some(css) = to_css(&[from.unwrap_or(at), at]) {
                overlay::dispatch(
                    app,
                    Surface::Draw,
                    DRAW_BOX,
                    &json!({ "from": css[0], "to": css[1] }),
                );
            }
        }
        DragLook::Started(at) | DragLook::Moved(at) => {
            let refused = with_session(app, |s| s.refused.is_some()).unwrap_or(true);
            if let (false, Some(css)) = (refused, to_css(&[at])) {
                overlay::dispatch(
                    app,
                    Surface::Draw,
                    DRAW_LIVE,
                    &json!({ "start": started, "points": css }),
                );
            }
        }
        DragLook::Finished(points) if selecting => select_dragged(app, &points),
        DragLook::Finished(points) => {
            if let Some(points) = with_session(app, |s| on_monitor(s.monitor, points)) {
                add_mark(app, points);
            }
        }
    }
    state(app).is_some_and(|s| s.drag.active())
}

/// A mouse stroke's points, kept on the session's monitor (the cursor can run off its edge).
fn on_monitor(monitor: ScreenRect, points: Vec<Pt>) -> Vec<Pt> {
    let (right, bottom) = ((monitor.right - 1) as f32, (monitor.bottom - 1) as f32);
    points
        .into_iter()
        .map(|(x, y)| {
            (
                x.clamp(monitor.left as f32, right),
                y.clamp(monitor.top as f32, bottom),
            )
        })
        .collect()
}

/// What keeps the pointer hidden whatever the setting (checked twice a second).
fn what_hides(privacy: &super::config::Privacy) -> Hide {
    let blocked_app = target::foreground_app_window()
        .and_then(target::exe_name_of)
        .is_some_and(|app| super::privacy::blocklist::is_blocked(&app, &privacy.blocked_apps));
    Hide {
        off: false,
        fullscreen: target::foreground_is_fullscreen(),
        in_call: super::win::system::call_or_recording_in_progress(),
        blocked_app,
    }
}

fn update_look<R: Runtime>(app: &AppHandle<R>, drawing: bool) {
    let look = {
        let Some(mut state) = state(app) else {
            return;
        };
        let look = match &state.session {
            _ if drawing && state.session.as_ref().is_some_and(|s| s.refused.is_some()) => {
                PointerLook::Blocked
            }
            _ if state.listening => PointerLook::Listening,
            _ if drawing => PointerLook::Drawing,
            Some(session) => match session.stage {
                Stage::Answering => circle_answer::look(session),
                _ => PointerLook::Idle,
            },
            None => PointerLook::Idle,
        };
        if state.look == Some(look) {
            return;
        }
        state.look = Some(look);
        look
    };
    overlay::dispatch(
        app,
        Surface::Pointer,
        POINTER_LOOK,
        &json!({ "look": look }),
    );
}

// ─── Draw mode ───────────────────────────────────────────────────────────────────────────────

/// The hold gesture went down or up (K2): draw mode follows it (the tracker reads this).
pub fn set_hold<R: Runtime>(app: &AppHandle<R>, held: bool) {
    if held {
        start_tracker(app);
    }
    if let Some(mut state) = state(app) {
        state.hold = held;
    }
}

/// The hold is listening for words (the pointer shows "listening").
pub fn set_listening<R: Runtime>(app: &AppHandle<R>, listening: bool) {
    if let Some(mut state) = state(app) {
        state.listening = listening;
    }
}

/// A double tap of Ctrl+Alt (K2; it was Ctrl+Alt+D): draw mode on or off, for pen and touch,
/// which can't hold keys. In silent mode it also draws with the keyboard (§4): the draw overlay
/// takes the keyboard while it's on.
pub fn toggle_draw_mode<R: Runtime>(app: &AppHandle<R>) {
    start_tracker(app);
    let keyboard = coach::circle_settings(app).silent;
    let now_on = state(app).map(|mut s| {
        s.draw_toggle = !s.draw_toggle;
        if s.draw_toggle && keyboard {
            s.keyboard = Some(input::foreground());
        }
        s.draw_toggle
    });
    match now_on {
        Some(true) if keyboard => start_keyboard_drawing(app),
        Some(false) => end_keyboard_drawing(app),
        _ => {}
    }
}

/// Keyboard drawing begins: the overlay takes the keyboard, and the screen is captured (the
/// student asked to draw) so its text blocks can be picked with Tab.
fn start_keyboard_drawing<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(Surface::Draw.label()) else {
        return;
    };
    begin_session_if_needed(app, &window);
    overlay::set_click_through(&window, false);
    overlay::set_activatable(&window, true);
    overlay::focus_quietly(&window);
    let needs_capture = with_session(app, |s| {
        let needs = s.capture.is_none() && !s.capturing && s.refused.is_none();
        if needs {
            s.capturing = true;
        }
        needs
    });
    match needs_capture {
        Some(true) => coach::capture_for_circle(app),
        _ => send_blocks(app),
    }
}

/// Keyboard drawing ends: the keyboard goes to the ask bar (to type, or Enter), or back to the
/// window that had it when there are no marks.
fn end_keyboard_drawing<R: Runtime>(app: &AppHandle<R>) {
    let Some(previous) = state(app).and_then(|mut s| s.keyboard.take()) else {
        return;
    };
    if let Some(window) = app.get_webview_window(Surface::Draw.label()) {
        overlay::set_activatable(&window, false);
    }
    if in_session(app) {
        if let Some(card) = app.get_webview_window(Surface::Card.label()) {
            overlay::focus_quietly(&card);
        }
    } else {
        input::give_focus_back(previous);
    }
}

/// The capture's text blocks for keyboard drawing (CSS pixels of the overlay, nearest the
/// pointer first). Rectangles only: the words stay here.
fn send_blocks<R: Runtime>(app: &AppHandle<R>) {
    let keyboard = state(app).is_some_and(|s| s.keyboard.is_some());
    if !keyboard {
        return;
    }
    let rules = coach::privacy_of(app).redaction;
    let cursor = input::cursor().unwrap_or_default();
    let blocks = with_session(app, |s| {
        let captured = s.capture.as_ref()?;
        let scale = s.scale() as f32;
        let monitor = s.monitor;
        let mut rects: Vec<ScreenRect> = captured
            .detail
            .text
            .blocks(&rules)
            .into_iter()
            .map(|b| b.rect)
            .collect();
        let distance = |r: &ScreenRect| {
            let (cx, cy) = ((r.left + r.right) / 2, (r.top + r.bottom) / 2);
            i64::from(cx - cursor.0).pow(2) + i64::from(cy - cursor.1).pow(2)
        };
        rects.sort_by_key(distance);
        Some(
            rects
                .into_iter()
                .take(40)
                .map(|r| {
                    [
                        (r.left - monitor.left) as f32 / scale,
                        (r.top - monitor.top) as f32 / scale,
                        r.width() as f32 / scale,
                        r.height() as f32 / scale,
                    ]
                })
                .collect::<Vec<_>>(),
        )
    })
    .flatten()
    .unwrap_or_default();
    let pointer = with_session(app, |s| {
        let scale = s.scale() as f32;
        [
            (cursor.0 - s.monitor.left) as f32 / scale,
            (cursor.1 - s.monitor.top) as f32 / scale,
        ]
    });
    overlay::dispatch(
        app,
        Surface::Draw,
        DRAW_SHOW,
        &json!({ "mode": "keyboard", "blocks": blocks, "pointer": pointer }),
    );
}

/// Draw mode started or ended: the overlay takes the mouse, pen and touch, or lets them through.
fn set_drawing<R: Runtime>(app: &AppHandle<R>, drawing: bool) {
    let Some(window) = app.get_webview_window(Surface::Draw.label()) else {
        return;
    };
    if drawing {
        begin_session_if_needed(app, &window);
    }
    eprintln!("[screen] draw mode {}", if drawing { "on" } else { "off" });
    overlay::set_click_through(&window, !drawing);
    show_marks(app);
}

/// The first stroke of a session: a session on the monitor under the cursor, and the privacy
/// checks for the app in front, before anything is captured (§3.2).
fn begin_session_if_needed<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let has_session = state(app).is_some_and(|s| s.session.is_some());
    if has_session {
        return;
    }
    let Some((x, y)) = input::cursor() else {
        return;
    };
    let Some((monitor, dpi)) = target::monitor_at(x, y) else {
        return;
    };
    // Circle & Ask owns the ink overlay now: an earlier answer's ink goes.
    super::annotate::clear(app);
    if let Some(mut state) = state(app) {
        state.session = Some(Session {
            id: new_session_id(),
            monitor,
            dpi,
            marks: Vec::new(),
            refused: None,
            capture: None,
            capturing: false,
            watch: None,
            stage: Stage::Marking,
            last_input: Instant::now(),
            answer: None,
            history: Vec::new(),
            entry: None,
            pending: None,
            place: None,
            place_offer: None,
            save_only_pending: false,
            paused_for_words: false,
            last_view: None,
        });
    }
    overlay::place(window, monitor);
    overlay::show_quietly(window);

    let handle = app.clone();
    coach::on_worker(app, move |tools| {
        let privacy = coach::privacy_of(&handle);
        if let Err(refusal) = super::pipeline::may_use_screen_now(tools, &privacy) {
            eprintln!(
                "[screen] drawing can't look at this app: {}",
                refusal.message()
            );
            with_session(&handle, |s| s.refused = Some(refusal.message()));
            show_marks(&handle);
            circle_answer::show_card_message(&handle, &refusal.message());
        }
    });
}

fn new_session_id() -> String {
    let bytes = super::win::crypto::random_bytes::<16>().unwrap_or([0; 16]);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    // A version 4 UUID (the server checks the shape).
    format!(
        "{}-{}-4{}-{}{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        ["8", "9", "a", "b"][usize::from(bytes[8] % 4)],
        &hex[17..20],
        &hex[20..32]
    )
}

// ─── Marks ───────────────────────────────────────────────────────────────────────────────────

/// A finished stroke from the draw overlay (CSS pixels of the overlay; pressure 0–1).
#[derive(Debug, Clone, Deserialize)]
pub struct DrawnStroke {
    points: Vec<[f32; 3]>,
}

/// The draw overlay reports a finished mark.
#[tauri::command(async)]
pub fn screen_draw_mark<R: Runtime>(
    window: WebviewWindow<R>,
    stroke: DrawnStroke,
) -> Result<(), String> {
    require_surface(&window, Surface::Draw)?;
    let app = window.app_handle();
    // A pen can move the mouse too: a stroke the tracker read already is the same one.
    let mouse_drew = state(app).is_some_and(|s| {
        s.drag.active() || s.dragged_at.is_some_and(|at| at.elapsed() < SAME_STROKE)
    });
    if mouse_drew {
        return Ok(());
    }
    let points = to_screen_points(app, &stroke.points).ok_or("Not allowed.")?;
    add_mark(app, points);
    Ok(())
}

/// The pen's eraser end: removes the last mark.
#[tauri::command(async)]
pub fn screen_draw_erase<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    require_surface(&window, Surface::Draw)?;
    let app = window.app_handle();
    with_session(app, |s| {
        s.marks.pop();
        s.last_input = Instant::now();
    });
    show_marks(app);
    Ok(())
}

/// The overlay's CSS pixels → screen pixels (checked: finite, on the monitor, not too many).
fn to_screen_points<R: Runtime>(app: &AppHandle<R>, points: &[[f32; 3]]) -> Option<Vec<Pt>> {
    const MAX_POINTS: usize = 5_000;
    if points.is_empty() || points.len() > MAX_POINTS {
        return None;
    }
    let (monitor, scale) = state(app)?
        .session
        .as_ref()
        .map(|s| (s.monitor, s.scale() as f32))?;
    let (w, h) = (monitor.width() as f32, monitor.height() as f32);
    points
        .iter()
        .map(|[x, y, _]| {
            let (px, py) = (x * scale, y * scale);
            (px.is_finite() && py.is_finite() && (0.0..=w).contains(&px) && (0.0..=h).contains(&py))
                .then_some((monitor.left as f32 + px, monitor.top as f32 + py))
        })
        .collect()
}

/// Understands a finished mark and adds it (up to three); the first one captures the screen.
fn add_mark<R: Runtime>(app: &AppHandle<R>, points: Vec<Pt>) {
    // A new mark while an explanation plays is barge-in: the explanation stops, the mark adds to
    // the session (a follow-up, §2.4).
    circle_answer::interrupt(app);
    let outcome = with_session(app, |session| {
        session.last_input = Instant::now();
        if session.refused.is_some() {
            return MarkOutcome::Refused;
        }
        if session.marks.len() >= MAX_MARKS {
            return MarkOutcome::Full;
        }
        let kind = marks::classify(&points, session.scale() as f32);
        let mut mark = Mark {
            number: session.marks.len() as u8 + 1,
            kind,
            points,
            targets: Vec::new(),
            region: None,
        };
        if let Some(captured) = &session.capture {
            understand(
                &mut mark,
                &captured.detail.text.word_boxes(),
                session.scale() as f32,
            );
        }
        session.marks.push(mark);
        session.stage = Stage::Marking;
        if session.capture.is_none() && !session.capturing {
            session.capturing = true;
            MarkOutcome::Capture
        } else {
            MarkOutcome::Added
        }
    });
    show_marks(app);
    match outcome {
        Some(MarkOutcome::Capture) => coach::capture_for_circle(app),
        Some(MarkOutcome::Full) => circle_answer::show_card_message(
            app,
            "Up to three marks at a time. Ask about these, or press Esc to start again.",
        ),
        Some(MarkOutcome::Added) => circle_answer::show_ask_bar(app),
        // Say why again: the student may have missed it when drawing began.
        Some(MarkOutcome::Refused) => {
            if let Some(reason) = with_session(app, |s| s.refused.clone()).flatten() {
                circle_answer::show_card_message(app, &reason);
            }
        }
        None => {}
    }
}

enum MarkOutcome {
    Added,
    Capture,
    Full,
    Refused,
}

/// Finds what a mark is about on the capture's text.
fn understand(mark: &mut Mark, words: &[WordBox], scale: f32) {
    mark.targets = marks::target_words(mark.kind, &mark.points, words, scale);
    mark.region = marks::region(&mark.points, words, &mark.targets);
}

/// The capture for the first mark arrived (on the capture worker thread).
pub fn on_captured<R: Runtime>(app: &AppHandle<R>, captured: Captured) {
    let window = captured.meta.window;
    let ok = with_session(app, |session| {
        session.capturing = false;
        // The cursor (and so the capture) moved to another monitor meanwhile: not what was marked.
        if captured.meta.monitor != session.monitor {
            return false;
        }
        let words = captured.detail.text.word_boxes();
        let scale = session.scale() as f32;
        for mark in &mut session.marks {
            understand(mark, &words, scale);
        }
        session.capture = Some(captured);
        true
    });
    match ok {
        Some(true) => {
            watch(app, window);
            if in_session(app) {
                circle_answer::show_ask_bar(app);
            }
            send_blocks(app);
            circle_answer::ask_pending(app);
        }
        Some(false) => {
            circle_answer::show_card_message(app, "Draw on one screen at a time, then ask.");
            end_session(app);
        }
        None => {} // the session ended meanwhile (Esc): the capture is wiped here
    }
}

/// The capture for the marks was refused or failed (the reason was shown).
pub fn capture_failed<R: Runtime>(app: &AppHandle<R>) {
    with_session(app, |s| s.capturing = false);
    end_session(app);
}

/// Watches the window the marks are on: if it moves, scrolls or closes, they no longer match.
fn watch<R: Runtime>(app: &AppHandle<R>, window: Option<isize>) {
    let Some(raw) = window else {
        return;
    };
    let handle = app.clone();
    let started = winevent::start(
        windows::Win32::Foundation::HWND(raw as *mut _),
        move |change| content_changed(&handle, change),
    );
    with_session(app, |s| s.watch = started);
}

/// The content under the marks moved (§3.2.4): the marks fade and the capture goes, unless an
/// explanation is waiting to be saved (its capture is what was explained).
fn content_changed<R: Runtime>(app: &AppHandle<R>, change: Change) {
    // Dragging is drawing (the overlay takes the drag); typing is the ask bar.
    if matches!(change, Change::Dragged | Change::Typed) {
        return;
    }
    eprintln!("[screen] marks faded ({change:?})");
    circle_answer::interrupt(app);
    let keep_for_saving = with_session(app, |s| {
        s.watch = None;
        s.marks.clear();
        let keep = circle_answer::has_unsaved_answer(s);
        if !keep {
            s.capture = None;
        }
        keep
    });
    overlay::dispatch(app, Surface::Draw, DRAW_FADE, &json!({}));
    overlay::dispatch(app, Surface::Ink, "mew:ink-fade", &json!({}));
    if keep_for_saving != Some(true) {
        end_session(app);
    }
}

/// Sends the marks to the draw overlay to show (the one being drawn is the page's own).
pub(super) fn show_marks<R: Runtime>(app: &AppHandle<R>) {
    let view = state(app).and_then(|state| {
        let drawing = state.drawing;
        let session = state.session.as_ref()?;
        let scale = session.scale() as f32;
        let monitor = session.monitor;
        let grey = session.refused.is_some();
        let marks: Vec<_> = session
            .marks
            .iter()
            .map(|mark| {
                json!({
                    "number": mark.number,
                    "points": mark.points.iter().map(|(x, y)| {
                        [(x - monitor.left as f32) / scale, (y - monitor.top as f32) / scale]
                    }).collect::<Vec<_>>(),
                })
            })
            .collect();
        Some(json!({ "marks": marks, "grey": grey, "drawing": drawing, "mode": "draw" }))
    });
    let view = view
        .unwrap_or_else(|| json!({ "marks": [], "grey": false, "drawing": false, "mode": "draw" }));
    overlay::dispatch(app, Surface::Draw, DRAW_SHOW, &view);
}

// ─── Ending ──────────────────────────────────────────────────────────────────────────────────

/// Clears everything: marks, ink, card, and the capture (wiped). Esc, pausing, or the end.
pub fn end_session<R: Runtime>(app: &AppHandle<R>) {
    let ended = state(app).and_then(|mut s| {
        s.selecting = false;
        s.session.take()
    });
    if ended.is_none() {
        return;
    }
    circle_answer::stopped(app);
    drop(ended); // the capture and its pixels are wiped here
    set_keys(app, false);
    overlay::dispatch(
        app,
        Surface::Draw,
        DRAW_SHOW,
        &json!({ "marks": [], "grey": false, "drawing": false, "mode": "draw" }),
    );
    overlay::dispatch(app, Surface::Ink, "mew:ink-clear", &json!({}));
    overlay::hide_quietly_named(app, Surface::Ink);
    overlay::hide_quietly_named(app, Surface::Card);
    if !state(app).is_some_and(|s| s.drawing) {
        overlay::hide_quietly_named(app, Surface::Draw);
    }
}

/// The ask bar closes after 20 s without input; the marks go a minute later (§2.3).
fn expire_session<R: Runtime>(app: &AppHandle<R>, now: Instant) {
    let idle = state(app).and_then(|s| {
        let session = s.session.as_ref()?;
        (session.stage == Stage::Marking && !s.drawing)
            .then(|| now.duration_since(session.last_input))
    });
    match idle {
        Some(idle) if idle >= ASK_IDLE + MARKS_KEPT => end_session(app),
        Some(idle) if idle >= ASK_IDLE => overlay::hide_quietly_named(app, Surface::Card),
        _ => {}
    }
}

/// True while a session is going on (it takes Esc, and the words said while holding the keys).
pub fn in_session<R: Runtime>(app: &AppHandle<R>) -> bool {
    state(app).is_some_and(|s| s.session.as_ref().is_some_and(|s| !s.marks.is_empty()))
}

// ─── Esc while a session needs it ────────────────────────────────────────────────────────────

fn escape() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

/// Registers or unregisters Esc. Never call with a lock held. (The step controls are the card's
/// keys now, → and ←: K2 keeps every shortcut to two keys.)
pub(super) fn set_keys<R: Runtime>(app: &AppHandle<R>, on: bool) {
    if KEYS_ON.swap(on, Ordering::SeqCst) == on {
        return;
    }
    let shortcuts = app.global_shortcut();
    // The ink overlay may hold Esc too (the same shortcut): only the first registration counts,
    // and Esc goes to whoever needs it (`takes_escape`).
    let _ = if on {
        shortcuts.register(escape())
    } else if !super::annotate::escape_on() {
        shortcuts.unregister(escape())
    } else {
        Ok(())
    };
}

/// Esc is registered for Circle & Ask.
pub(super) fn keys_on() -> bool {
    KEYS_ON.load(Ordering::SeqCst)
}

/// Esc belongs to Circle & Ask while it has a session (before the ink overlay's own Esc).
pub fn takes_escape<R: Runtime>(app: &AppHandle<R>) -> bool {
    KEYS_ON.load(Ordering::SeqCst) && state(app).is_some_and(|s| s.session.is_some())
}

/// A global shortcut Circle & Ask registered (Esc). True if it was ours.
pub fn on_shortcut<R: Runtime>(
    app: &AppHandle<R>,
    shortcut: &Shortcut,
    pressed: ShortcutState,
) -> bool {
    if !KEYS_ON.load(Ordering::SeqCst) || shortcut != &escape() {
        return false;
    }
    if pressed == ShortcutState::Pressed {
        // Esc: stops an explanation first; a second Esc clears everything (§2.2).
        if !circle_answer::stop_if_playing(app) {
            end_session(app);
        }
    }
    true
}

// ─── The card's buttons ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardAction {
    /// Ask with the typed words (or "explain this" with none).
    Ask,
    /// "Select question on screen".
    SelectQuestion,
    /// Use the question read from the screen (as edited).
    Confirm,
    Pause,
    Resume,
    Repeat,
    Next,
    Stop,
    Undo,
    EditCrop,
    Open,
    /// Save now ("ask each time").
    Save,
    /// Ctrl+S in the ask bar: save the marks without an explanation (K2 §11.2).
    SaveOnly,
    /// K3: the picker ("Change", the chip's ▾, Ctrl+D).
    ChangePlace,
    /// K3: one of the offered places (its index is the text).
    PickPlace,
    /// K3: "Create it and save".
    CreatePlace,
    PlaceCancel,
    Close,
}

/// The card's buttons and its text box.
#[tauri::command(async)]
pub fn screen_circle_card<R: Runtime>(
    window: WebviewWindow<R>,
    action: CardAction,
    text: Option<String>,
) -> Result<(), String> {
    require_surface(&window, Surface::Card)?;
    let app = window.app_handle();
    with_session(app, |s| s.last_input = Instant::now());
    let words = text
        .as_deref()
        .map(clean_question)
        .filter(|t| !t.is_empty());
    match action {
        // Typed "save to physics ch 5": a save, not a question (K3 §4.2).
        CardAction::Ask if words.as_deref().and_then(save_to_phrase).is_some() => {
            if let Some(phrase) = words.as_deref().and_then(save_to_phrase) {
                circle_answer::save_to(app, phrase);
            }
        }
        CardAction::Ask => {
            let question = match words {
                Some(text) => Question::Typed { text },
                None => Question::None,
            };
            circle_answer::ask(app, question);
        }
        CardAction::Confirm => {
            let text = words.ok_or("Type the question first.")?;
            circle_answer::ask(
                app,
                Question::ScreenSelection {
                    text,
                    handwritten: true,
                    confidence: 1.0, // the student confirmed it
                },
            );
        }
        CardAction::SelectQuestion => select_question(app),
        CardAction::Pause => circle_answer::control(app, circle_answer::Control::Pause),
        CardAction::Resume => circle_answer::control(app, circle_answer::Control::Resume),
        CardAction::Repeat => circle_answer::control(app, circle_answer::Control::Repeat),
        CardAction::Next => circle_answer::control(app, circle_answer::Control::Next),
        CardAction::Stop => {
            circle_answer::stop_if_playing(app);
        }
        CardAction::Undo => circle_answer::undo(app),
        CardAction::EditCrop => circle_answer::edit_crop(app),
        CardAction::Open => circle_answer::save_now(app, true),
        CardAction::Save => circle_answer::save_now(app, false),
        CardAction::SaveOnly => circle_answer::save_marks(app),
        CardAction::ChangePlace => circle_answer::change_place(app),
        CardAction::PickPlace => {
            let index = text.as_deref().and_then(|t| t.trim().parse::<usize>().ok());
            circle_answer::pick_place(app, index.ok_or("Choose a place.")?);
        }
        CardAction::CreatePlace => circle_answer::create_place(app),
        CardAction::PlaceCancel => circle_answer::cancel_place(app),
        CardAction::Close => end_session(app),
    }
    Ok(())
}

/// The words said while holding the keys during a session are its question (or a follow-up).
pub fn takes_words<R: Runtime>(app: &AppHandle<R>) -> bool {
    in_session(app)
}

/// Circled and talked: the words are the question. Circled without a word: the ask bar opens
/// (K2 §11.1), to type a question or press Enter. "Save it to Physics chapter 5" is a command,
/// not a question (K3 §4.2): an explanation paused for the words goes on.
pub fn on_words<R: Runtime>(app: &AppHandle<R>, transcript: &str) {
    let text = clean_question(transcript);
    if let Some(phrase) = save_to_phrase(&text) {
        circle_answer::save_to(app, phrase);
    } else if text.is_empty() {
        if !circle_answer::resume_after_words(app) {
            circle_answer::show_ask_bar(app);
        }
    } else {
        circle_answer::interrupt(app);
        circle_answer::ask(app, Question::Voice { text });
    }
}

/// The hold was cancelled (another key): an explanation paused for it goes on.
pub fn words_cancelled<R: Runtime>(app: &AppHandle<R>) {
    circle_answer::resume_after_words(app);
}

/// The hold went down during a session: the student is about to speak. The explanation pauses
/// (K3: if the words are only "save it to …", it goes on; a question stops it, `on_words`).
pub fn on_listen<R: Runtime>(app: &AppHandle<R>) {
    circle_answer::pause_for_words(app);
    with_session(app, |s| s.last_input = Instant::now());
}

// ─── Selecting a question on screen ──────────────────────────────────────────────────────────

/// "Select question on screen": the draw overlay turns into a drag box (§3.5).
fn select_question<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(Surface::Draw.label()) else {
        return;
    };
    overlay::set_click_through(&window, false);
    if let Some(mut state) = state(app) {
        state.selecting = true;
    }
    overlay::dispatch(app, Surface::Draw, DRAW_SHOW, &json!({ "mode": "select" }));
}

/// The mouse dragged a box around the question (the tracker read it; screen pixels).
fn select_dragged<R: Runtime>(app: &AppHandle<R>, points: &[Pt]) {
    let (Some(&(x0, y0)), Some(&(x1, y1))) = (points.first(), points.last()) else {
        return;
    };
    let area = with_session(app, |s| {
        let min = MIN_BOX * s.scale() as f32;
        let big_enough = (x1 - x0).abs() >= min && (y1 - y0).abs() >= min;
        big_enough.then(|| ScreenRect {
            left: x0.min(x1) as i32,
            top: y0.min(y1) as i32,
            right: x0.max(x1) as i32,
            bottom: y0.max(y1) as i32,
        })
    })
    .flatten();
    match area {
        Some(area) => ask_about_area(app, area),
        // A slip: the box goes and the next drag tries again.
        None => overlay::dispatch(app, Surface::Draw, DRAW_SHOW, &json!({ "mode": "select" })),
    }
}

/// Selecting is over: the overlay goes back to draw mode, and the question in `area` is read.
fn ask_about_area<R: Runtime>(app: &AppHandle<R>, area: ScreenRect) {
    let drawing = state(app).is_some_and(|mut s| {
        s.selecting = false;
        s.drawing
    });
    if let Some(window) = app.get_webview_window(Surface::Draw.label()) {
        overlay::set_click_through(&window, !drawing);
    }
    show_marks(app);
    coach::capture_for_question(app, area);
}

/// The student dragged a box around their question (overlay CSS pixels: x, y, width, height).
#[tauri::command(async)]
pub fn screen_draw_select<R: Runtime>(
    window: WebviewWindow<R>,
    rect: [f32; 4],
) -> Result<(), String> {
    require_surface(&window, Surface::Draw)?;
    let app = window.app_handle();
    let area = with_session(app, |s| {
        let scale = s.scale() as f32;
        let [x, y, w, h] = rect;
        let ok = [x, y, w, h].iter().all(|v| v.is_finite()) && w >= MIN_BOX && h >= MIN_BOX;
        ok.then(|| ScreenRect {
            left: s.monitor.left + (x * scale) as i32,
            top: s.monitor.top + (y * scale) as i32,
            right: s.monitor.left + ((x + w) * scale) as i32,
            bottom: s.monitor.top + ((y + h) * scale) as i32,
        })
    })
    .flatten()
    .ok_or("Drag a box around the question.")?;
    ask_about_area(app, area);
    Ok(())
}
