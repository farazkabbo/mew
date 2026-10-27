//! Screen Coach's runtime on Windows: settings, the hold gesture, the tray, and the capture worker.
//!
//! Captures start only here, from the hold gesture and tray handlers (decision 2). No command a page
//! can call starts a capture or returns screen pixels. What a capture does, step by step, is in
//! `pipeline.rs`; asking about it is in `ask.rs`; connecting to the account in `account.rs`;
//! ink on screen in `annotate.rs` and saving clips in `clip.rs` (S3); walkthroughs in
//! `coach_mode.rs` (S4); Circle & Ask in `circle.rs` (S3.2).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use tauri::image::Image;
use tauri::ipc::CapabilityBuilder;
use tauri::menu::{CheckMenuItem, MenuItem};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use super::account::PendingLink;
use super::annotate::{self, InkState};
use super::ask;
use super::circle;
use super::clip::{self, ClipDraft, ClipPlace, Purpose};
use super::coach_mode::{self, CoachCapture, CoachState};
use super::config::{self, CaptureScope, Loaded, Privacy, ScreenConfig, CONSENT_VERSION};
use super::frame::{CapturedFrame, FrameMeta, FrameSlot, Timings, FRAME_TTL};
use super::hold::HoldEvent;
use super::page;
use super::pipeline::{self, Captured, Request, ScreenError, Tools};
use super::privacy::blocklist::DEFAULT_BLOCKED_APPS;
use super::privacy::MicAccess;
use super::tray_badge::{with_badge, Status};
use super::win::{self, credential, indicator, system, ComThread, Unsupported};

/// The local settings page's window (and the only window its capability applies to).
pub const SETTINGS_WINDOW: &str = "screen-coach";
const SETTINGS_PAGE: &str = "screen-coach.html";
const CHANGED_SCRIPT: &str = "window.dispatchEvent(new Event('screen-coach:changed'))";

/// Tray menu items Screen Coach keeps up to date.
pub struct TrayItems<R: Runtime> {
    pub look: MenuItem<R>,
    pub pause: CheckMenuItem<R>,
    /// "Stop the walkthrough": enabled while one is in progress (S4).
    pub stop_walkthrough: MenuItem<R>,
}

pub struct ScreenCoach {
    config_path: PathBuf,
    /// The web app (and its server): where questions and sign-in go.
    app_url: Url,
    support: Result<(), Unsupported>,
    state: Mutex<State>,
    slot: FrameSlot,
    worker: Mutex<Sender<Job>>,
    capturing: AtomicBool,
    pending_link: Mutex<Option<PendingLink>>,
    /// The ink on screen (S3).
    ink: Mutex<InkState>,
    /// A clip waiting in its preview (S3).
    clip: Mutex<Option<ClipDraft>>,
    /// Where the next clip goes, said with it ("save this to Physics chapter 5", K3).
    clip_place: Mutex<Option<ClipPlace>>,
    /// The walkthrough in progress, as far as the desktop knows it (S4).
    coaching: Mutex<CoachState>,
    /// Circle & Ask: draw mode and the session (S3.2).
    circle: Mutex<circle::CircleState>,
}

struct State {
    config: ScreenConfig,
    /// The settings file was unreadable and was reset (the settings page says so).
    config_reset: bool,
    status: Status,
    /// The hold gesture is down (K2).
    talk_held: bool,
    /// The page is listening for this hold.
    hold_active: bool,
    /// The capture for the last hold was refused (and the student was told why): its words
    /// aren't asked about.
    hold_refused: bool,
    /// A device token is saved: Screen Coach can ask the server.
    connected: bool,
}

/// What the settings page shows. Nothing here is screen content; the blocked list is the
/// user's own setting.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub supported: bool,
    pub unsupported_reason: Option<&'static str>,
    pub on: bool,
    pub paused: bool,
    pub status: Status,
    pub consent_version: u32,
    pub settings_reset: bool,
    /// "Shortcuts got simpler" is waiting to be read (K2: the old hotkeys were replaced).
    pub shortcuts_notice: bool,
    pub privacy: Privacy,
    pub circle: config::CircleSettings,
    pub default_blocked_apps: &'static [&'static str],
    pub microphone: MicAccess,
    /// Connected to the user's Mew account (a device token is saved).
    pub connected: bool,
}

/// Who asked for a capture: the hold gesture without marks (the page listened; it asks with the
/// words), the tray (asked at once, without words), saving a clip (S3), or the progress pill's
/// Done, Hint and Resume (S4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Origin {
    Hotkey,
    Tray,
    Clip(Purpose),
    Coach(CoachCapture),
    /// Circle & Ask: the monitor under the first mark (S3.2 §3.2).
    Circle,
    /// Circle & Ask: the area the student selected around their question.
    Question(super::frame::ScreenRect),
}

/// Work for the capture worker thread, which owns the Windows objects in `Tools`.
type Job = Box<dyn FnOnce(&mut Tools) + Send>;

impl ScreenCoach {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn view(&self) -> StatusView {
        let state = self.lock();
        StatusView {
            supported: self.support.is_ok(),
            unsupported_reason: self.support.err().map(|reason| match reason {
                Unsupported::WindowsTooOld => {
                    "Screen Coach needs Windows 10 version 2004 or later, or Windows 11."
                }
                Unsupported::CaptureUnavailable => {
                    "Windows can't capture the screen on this PC (screen capture isn't available)."
                }
            }),
            on: state.config.is_on(),
            paused: state.config.paused,
            status: state.status,
            consent_version: CONSENT_VERSION,
            settings_reset: state.config_reset,
            shortcuts_notice: state.config.shortcuts_notice,
            privacy: state.config.privacy.clone(),
            circle: state.config.circle.clone(),
            default_blocked_apps: DEFAULT_BLOCKED_APPS,
            microphone: system::mic_access(),
            connected: state.connected,
        }
    }

    pub fn app_url(&self) -> &Url {
        &self.app_url
    }

    pub fn pending_link(&self) -> std::sync::MutexGuard<'_, Option<PendingLink>> {
        self.pending_link
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn set_connected(&self, connected: bool) {
        self.lock().connected = connected;
    }

    pub fn ink(&self) -> std::sync::MutexGuard<'_, InkState> {
        self.ink
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn clip(&self) -> std::sync::MutexGuard<'_, Option<ClipDraft>> {
        self.clip
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn clip_place(&self) -> std::sync::MutexGuard<'_, Option<ClipPlace>> {
        self.clip_place
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn coaching(&self) -> std::sync::MutexGuard<'_, CoachState> {
        self.coaching
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn circle(&self) -> std::sync::MutexGuard<'_, circle::CircleState> {
        self.circle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The privacy settings right now.
    pub fn privacy(&self) -> Privacy {
        self.lock().config.privacy.clone()
    }

    pub fn is_capturing(&self) -> bool {
        self.capturing.load(Ordering::SeqCst)
    }

    /// The held frame, handed over once (for asking about it).
    pub fn take_frame(&self) -> Option<CapturedFrame> {
        self.slot.take_latest(Instant::now())
    }

    fn resting_status(&self, state: &State) -> Status {
        if self.support.is_err() {
            Status::Unsupported
        } else if !state.config.is_on() {
            Status::Off
        } else if state.config.paused {
            Status::Paused
        } else {
            Status::Idle
        }
    }

    fn save(&self, config: &ScreenConfig) -> Result<(), String> {
        config::save(&self.config_path, config)
            .map_err(|_| "Couldn't save Screen Coach settings.".to_owned())
    }

    /// Changes the settings: saved first, applied only if saving worked.
    fn update(&self, change: impl FnOnce(&mut ScreenConfig)) -> Result<(), String> {
        let mut state = self.lock();
        let mut next = state.config.clone();
        change(&mut next);
        self.save(&next)?;
        state.config = next;
        Ok(())
    }
}

/// Sets Screen Coach up at start-up. Never fails the app: problems leave Screen Coach off.
pub fn setup<R: Runtime>(app: &AppHandle<R>, app_url: Url) -> tauri::Result<()> {
    win::exclude_heap_from_crash_dumps();
    let support = win::check_support();
    let config_path = config::path_in(&app.path().app_config_dir()?);
    let loaded = config::load(&config_path);
    let config_reset = matches!(loaded, Loaded::Reset(_));
    let config = loaded.into_config();
    let shortcuts_notice = config.shortcuts_notice && config.is_on();
    let state = State {
        config,
        config_reset,
        status: Status::Off,
        talk_held: false,
        hold_active: false,
        hold_refused: false,
        connected: credential::is_saved(),
    };
    let coach = ScreenCoach {
        config_path,
        app_url,
        support,
        state: Mutex::new(state),
        slot: FrameSlot::default(),
        worker: Mutex::new(start_worker()),
        capturing: AtomicBool::new(false),
        pending_link: Mutex::new(None),
        ink: Mutex::new(InkState::default()),
        clip: Mutex::new(None),
        clip_place: Mutex::new(None),
        coaching: Mutex::new(CoachState::default()),
        circle: Mutex::new(circle::CircleState::default()),
    };
    {
        let mut state = coach.lock();
        state.status = coach.resting_status(&state);
    }
    app.manage(coach);
    settings_capability(app)?;
    overlay_capabilities(app)?;
    refresh(app);
    circle::start_tracker(app);
    if shortcuts_notice {
        notify(
            app,
            "Shortcuts got simpler: hold Ctrl+Alt to circle and talk, and double-tap Ctrl+Alt              for draw mode. Screen Coach settings lists what changed.",
        );
    }
    Ok(())
}

/// The bundled settings page (and only it) may call Screen Coach's settings commands. Remote
/// pages never get these: security settings can't be changed from the web (decision 1).
fn settings_capability<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.add_capability(
        CapabilityBuilder::new("screen-coach-settings")
            .local(true)
            .window(SETTINGS_WINDOW)
            .permission("allow-screen-coach-status")
            .permission("allow-screen-coach-set-enabled")
            .permission("allow-screen-coach-set-paused")
            .permission("allow-screen-coach-shortcuts-seen")
            .permission("allow-screen-coach-set-privacy")
            .permission("allow-screen-coach-set-circle")
            .permission("allow-screen-coach-open-mic-settings")
            .permission("allow-screen-coach-link-start")
            .permission("allow-screen-coach-disconnect"),
    )
}

/// Each overlay page (S3) may call only its own commands, and only from its own window: the
/// ink overlay reports what it drew, the pill has its two buttons, the preview its three, the
/// Notes Check panel its one (close, hide the marks, open a line in the notebook), and the
/// progress pill its one (its buttons, S4).
fn overlay_capabilities<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    use super::overlay::Surface;
    app.add_capability(
        CapabilityBuilder::new("screen-ink")
            .local(true)
            .window(Surface::Ink.label())
            .permission("allow-screen-ink-drawn"),
    )?;
    app.add_capability(
        CapabilityBuilder::new("screen-ink-pill")
            .local(true)
            .window(Surface::Pill.label())
            .permission("allow-screen-ink-pill"),
    )?;
    app.add_capability(
        CapabilityBuilder::new("screen-notes")
            .local(true)
            .window(Surface::Notes.label())
            .permission("allow-screen-notes-panel"),
    )?;
    app.add_capability(
        CapabilityBuilder::new("screen-coach-pill")
            .local(true)
            .window(Surface::Coach.label())
            .permission("allow-screen-coach-pill"),
    )?;
    // Circle & Ask (S3.2): the draw overlay reports marks and a selected area; the card has its
    // buttons. The pointer calls nothing.
    app.add_capability(
        CapabilityBuilder::new("screen-draw")
            .local(true)
            .window(Surface::Draw.label())
            .permission("allow-screen-draw-mark")
            .permission("allow-screen-draw-erase")
            .permission("allow-screen-draw-select"),
    )?;
    app.add_capability(
        CapabilityBuilder::new("screen-circle-card")
            .local(true)
            .window(Surface::Card.label())
            .permission("allow-screen-circle-card"),
    )?;
    app.add_capability(
        CapabilityBuilder::new("screen-quiz-card")
            .local(true)
            .window(Surface::Quiz.label())
            .permission("allow-screen-quiz-card"),
    )?;
    app.add_capability(
        CapabilityBuilder::new("screen-clip")
            .local(true)
            .window(Surface::Clip.label())
            .permission("allow-screen-clip-ready")
            .permission("allow-screen-clip-save")
            .permission("allow-screen-clip-cancel"),
    )
}

/// Opens (or brings forward) the local settings page.
pub fn open_settings<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let dev_url = app.config().build.dev_url.clone();
    let built =
        WebviewWindowBuilder::new(app, SETTINGS_WINDOW, WebviewUrl::App(SETTINGS_PAGE.into()))
            .title("Neb · Screen Coach")
            .inner_size(600.0, 760.0)
            .min_inner_size(420.0, 520.0)
            .additional_browser_args(crate::BROWSER_ARGS)
            // Bundled pages only: the page can't be navigated anywhere else.
            .on_navigation(move |url| super::is_local_page(url, dev_url.as_ref()))
            .build();
    if let Err(error) = built {
        eprintln!("[screen] couldn't open the settings window ({error})");
    }
}

/// Called for every global shortcut: only Esc, registered while ink or a Circle & Ask session is
/// on screen (K2: Screen Coach has no other global hotkeys; the hold gesture is polled).
pub fn on_shortcut<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut, pressed: ShortcutState) {
    // Esc is only registered while ink is on screen.
    if shortcut == &annotate::escape() && !circle::takes_escape(app) {
        if pressed == ShortcutState::Pressed {
            annotate::clear(app);
        }
        return;
    }
    circle::on_shortcut(app, shortcut, pressed);
}

/// The hold gesture (K2, docs/NOTEBOOKS_K.md §11.1; read by `keys.rs`). Holding left Ctrl + left
/// Alt draws and listens at the same time; on release, words said over marks ask about them,
/// marks without words open the ask bar, and words without marks are asked about one capture of
/// the screen, taken then. A double tap toggles draw mode. With Screen Coach off or paused, the
/// hold summons Neb's own window instead (nothing on the screen is looked at).
pub fn on_hold<R: Runtime>(app: &AppHandle<R>, event: HoldEvent) {
    let coach = app.try_state::<ScreenCoach>();
    let Some(coach) = coach.filter(|coach| usable(coach)) else {
        if event == HoldEvent::Started {
            crate::summon(app);
        }
        return;
    };
    match event {
        HoldEvent::Started => {
            circle::set_hold(app, true);
            let silent = circle_settings(app).silent;
            let in_session = circle::takes_words(app);
            if in_session {
                circle::on_listen(app); // barge-in: the explanation stops
            }
            let mut state = coach.lock();
            // Without a connection there is nothing to ask yet: drawing still works, and the
            // release says how to connect.
            if silent || !(state.connected || in_session) {
                return;
            }
            state.talk_held = true;
            state.hold_active = true;
            state.hold_refused = false;
            state.status = Status::Listening;
            drop(state);
            circle::set_listening(app, true);
            page::dispatch(app, page::LISTEN, serde_json::Value::Null);
            refresh(app);
        }
        HoldEvent::Ended | HoldEvent::Cancelled => {
            circle::set_hold(app, false);
            circle::set_listening(app, false);
            let mut state = coach.lock();
            state.talk_held = false;
            let was_listening = std::mem::take(&mut state.hold_active);
            if state.status == Status::Listening {
                state.status = coach.resting_status(&state);
            }
            let connected = state.connected;
            drop(state);
            let marked = circle::takes_words(app);
            if event == HoldEvent::Cancelled {
                if was_listening {
                    page::dispatch(app, page::CANCEL, serde_json::Value::Null);
                }
                circle::words_cancelled(app);
            } else if was_listening {
                // Words without marks are about the screen as it is now: one capture, which
                // the page's question waits for (`ask.rs`).
                if !marked && !capture(app, Origin::Hotkey, None) {
                    coach.lock().hold_refused = true;
                    page::dispatch(app, page::CANCEL, serde_json::Value::Null);
                } else {
                    page::dispatch(app, page::RELEASE, serde_json::Value::Null);
                }
            } else if !connected && !marked && !circle_settings(app).silent {
                notify(app, "Connect Screen Coach to your Neb account first: tray → Screen Coach settings → Connect.");
            }
            refresh(app);
        }
        HoldEvent::DoubleTap => circle::toggle_draw_mode(app),
    }
}

/// The capture for this hold's words was refused or failed (the student was told why): taken
/// once, so the words aren't asked about without a picture.
pub fn take_hold_refused<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<ScreenCoach>()
        .is_some_and(|coach| std::mem::take(&mut coach.lock().hold_refused))
}

/// "Pause Screen Coach" from the tray, or said ("Neb, pause").
pub fn toggle_pause<R: Runtime>(app: &AppHandle<R>) {
    let Some(coach) = app.try_state::<ScreenCoach>() else {
        return;
    };
    let paused = coach.lock().config.paused;
    if set_paused(app, !paused).is_err() {
        notify(app, "Couldn't save Screen Coach settings.");
    }
}

/// "Neb, pause" (said while holding the keys): Screen Coach pauses until resumed from the tray.
pub fn pause<R: Runtime>(app: &AppHandle<R>) {
    match set_paused(app, true) {
        Ok(_) => notify(app, "Screen Coach is paused. Resume it from the tray icon."),
        Err(_) => notify(app, "Couldn't save Screen Coach settings."),
    }
}

/// "Look at my screen" from the tray.
pub fn look_from_tray<R: Runtime>(app: &AppHandle<R>) {
    capture(app, Origin::Tray, None);
}

/// Captures the screen to clip from (S3): to re-place the earlier ink on, or to drag a region
/// out of. Only from the pill or "save this" (decision 2).
pub fn capture_for_clip<R: Runtime>(app: &AppHandle<R>, scope: CaptureScope, purpose: Purpose) {
    capture(app, Origin::Clip(purpose), Some(scope));
}

/// Captures the monitor under the cursor for a walkthrough (decision 6): only from the progress
/// pill's buttons, which the student clicked (decision 10).
pub fn capture_for_coach<R: Runtime>(app: &AppHandle<R>, kind: CoachCapture) {
    if !capture(app, Origin::Coach(kind), Some(CaptureScope::Monitor)) {
        coach_mode::capture_failed(app);
    }
}

/// Captures the monitor under the student's first mark (Circle & Ask: drawing is the trigger,
/// §7.1).
pub fn capture_for_circle<R: Runtime>(app: &AppHandle<R>) {
    if !capture(app, Origin::Circle, Some(CaptureScope::Monitor)) {
        circle::capture_failed(app);
    }
}

/// Captures the monitor to read the question the student selected (`area`, screen pixels).
pub fn capture_for_question<R: Runtime>(app: &AppHandle<R>, area: super::frame::ScreenRect) {
    capture(app, Origin::Question(area), Some(CaptureScope::Monitor));
}

/// On, not paused, on a supported PC (the pointer and draw mode run only then).
pub fn is_usable<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<ScreenCoach>()
        .is_some_and(|coach| usable(&coach))
}

/// Circle & Ask's settings right now.
pub fn circle_settings<R: Runtime>(app: &AppHandle<R>) -> config::CircleSettings {
    app.try_state::<ScreenCoach>()
        .map(|coach| coach.lock().config.circle.clone())
        .unwrap_or_default()
}

/// True the first time a walkthrough starts on this computer (then never again): the one-time
/// notice that coach mode sees the whole monitor (decision 6).
pub fn take_coach_notice<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(coach) = app.try_state::<ScreenCoach>() else {
        return false;
    };
    if coach.lock().config.coach_notice_seen {
        return false;
    }
    // If saving fails it's shown again next time: better twice than never.
    let _ = coach.update(|config| config.coach_notice_seen = true);
    true
}

/// On, not paused, on a supported PC: the hold gesture may act.
fn usable(coach: &ScreenCoach) -> bool {
    let state = coach.lock();
    coach.support.is_ok() && state.config.is_on() && !state.config.paused
}

/// Captures the screen for a question: only when Screen Coach is on, connected, not paused, and
/// not already capturing. The privacy checks themselves run in the pipeline. True if a capture
/// started.
fn capture<R: Runtime>(app: &AppHandle<R>, origin: Origin, scope: Option<CaptureScope>) -> bool {
    let Some(coach) = app.try_state::<ScreenCoach>() else {
        return false;
    };
    let request = {
        let mut state = coach.lock();
        if coach.support.is_err() || !state.config.is_on() || state.config.paused {
            return false;
        }
        if !state.connected {
            drop(state);
            notify(app, "Connect Screen Coach to your Neb account first: tray → Screen Coach settings → Connect.");
            return false;
        }
        if coach.capturing.swap(true, Ordering::SeqCst) {
            return false;
        }
        state.status = Status::Looking;
        // During a walkthrough the hold sees the monitor: menus and dialogs are often separate
        // windows (decision 6).
        let default_scope = if coach_mode::is_coaching(app) {
            CaptureScope::Monitor
        } else {
            state.config.privacy.ask_scope
        };
        Request {
            scope: scope.unwrap_or(default_scope),
            privacy: state.config.privacy.clone(),
        }
    };
    refresh(app);

    let handle = app.clone();
    let queued = on_worker(app, move |tools| {
        let result = pipeline::run(tools, &request);
        finish_capture(&handle, origin, result);
    });
    if !queued {
        finish_capture(app, origin, Err(ScreenError::Failed));
    }
    true
}

/// Runs `work` on the capture worker (one job at a time, with its Windows objects). False if
/// the worker couldn't take it.
pub fn on_worker<R: Runtime>(
    app: &AppHandle<R>,
    work: impl FnOnce(&mut Tools) + Send + 'static,
) -> bool {
    let Some(coach) = app.try_state::<ScreenCoach>() else {
        return false;
    };
    let job: Job = Box::new(work);
    let Ok(mut worker) = coach.worker.lock() else {
        return false;
    };
    if worker.send(job).is_ok() {
        return true;
    }
    // The worker died (it never should): start a new one for next time.
    *worker = start_worker();
    false
}

/// The privacy settings now (defaults if Screen Coach isn't set up: the strictest redaction is
/// still the default one).
pub fn privacy_of<R: Runtime>(app: &AppHandle<R>) -> Privacy {
    app.try_state::<ScreenCoach>()
        .map(|coach| coach.privacy())
        .unwrap_or_default()
}

/// Keeps the frame (and shows the indicator) or tells the user why there's none. A tray capture
/// is asked about at once; a hold's capture waits for the page to send the words.
fn finish_capture<R: Runtime>(
    app: &AppHandle<R>,
    origin: Origin,
    result: Result<Captured, ScreenError>,
) {
    let Some(coach) = app.try_state::<ScreenCoach>() else {
        return;
    };
    let mut kept = false;
    let mut for_clip = None;
    let mut for_coach = None;
    let mut for_circle = None;
    let mut for_question = None;
    match result {
        Ok(captured) => {
            log_capture(&captured.meta, captured.jpeg.len());
            let (monitor, dpi) = (captured.meta.monitor, captured.meta.dpi);
            // A pause pressed mid-capture wins: the frame is dropped (and wiped).
            if coach.lock().config.paused {
                drop(captured);
            } else {
                indicator::flash(monitor, dpi);
                match origin {
                    Origin::Clip(purpose) => for_clip = Some((purpose, captured)),
                    Origin::Coach(kind) => for_coach = Some((kind, captured)),
                    Origin::Circle => for_circle = Some(captured),
                    Origin::Question(area) => for_question = Some((area, captured)),
                    Origin::Hotkey | Origin::Tray => {
                        let Captured { jpeg, meta, detail } = captured;
                        coach.slot.put(jpeg, meta, Some(detail), Instant::now());
                        schedule_expiry(app);
                    }
                }
                kept = true;
            }
        }
        Err(error) => notify(app, &error.message()),
    }
    // Only now: an ask waiting for this capture reads the flag first, then the slot.
    coach.capturing.store(false, Ordering::SeqCst);
    if let Some((purpose, captured)) = for_clip {
        clip::on_captured(app, purpose, captured);
    }
    if let Some((kind, captured)) = for_coach {
        coach_mode::on_captured(app, kind, captured);
    }
    if let Some(captured) = for_circle {
        circle::on_captured(app, captured);
    }
    if let Some((area, captured)) = for_question {
        super::circle_answer::on_question_captured(app, area, captured);
    }
    match (origin, kept) {
        (Origin::Tray, true) => ask::ask_in_background(app, String::new()),
        (Origin::Hotkey, false) => {
            coach.lock().hold_refused = true;
            page::dispatch(app, page::CANCEL, serde_json::Value::Null);
        }
        (Origin::Coach(_), false) => coach_mode::capture_failed(app),
        (Origin::Circle, false) => circle::capture_failed(app),
        _ => {}
    }
    let mut state = coach.lock();
    state.status = if state.talk_held && state.config.is_on() && !state.config.paused {
        Status::Listening
    } else {
        coach.resting_status(&state)
    };
    drop(state);
    refresh(app);
}

fn schedule_expiry<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = std::thread::Builder::new()
        .name("mew-frame-expiry".into())
        .spawn(move || {
            std::thread::sleep(FRAME_TTL);
            if let Some(coach) = handle.try_state::<ScreenCoach>() {
                coach.slot.expire(Instant::now());
            }
        });
}

/// Timings and sizes only: never content, titles or app names (brief §7.9).
fn log_capture(meta: &FrameMeta, bytes: usize) {
    let Timings {
        checks_ms,
        capture_ms,
        redact_ms,
        downscale_ms,
        encode_ms,
    } = meta.timings;
    eprintln!(
        "[screen] captured {:?} {}x{} ({} KB) checks={checks_ms}ms capture={capture_ms}ms redact={redact_ms}ms downscale={downscale_ms}ms encode={encode_ms}ms",
        meta.kind,
        meta.width,
        meta.height,
        bytes.div_ceil(1024)
    );
}

pub fn notify<R: Runtime>(app: &AppHandle<R>, message: &str) {
    let _ = app
        .notification()
        .builder()
        .title("Screen Coach")
        .body(message)
        .show();
}

/// The capture worker: one thread with COM and the Windows objects captures need, handling one
/// job at a time.
fn start_worker() -> Sender<Job> {
    let (sender, receiver) = mpsc::channel::<Job>();
    let spawned = std::thread::Builder::new()
        .name("mew-screen-capture".into())
        .spawn(move || {
            // Without COM, every Windows object in `Tools` fails to start, so jobs fail closed
            // (no capture, no OCR, nothing sent).
            let _com = ComThread::init();
            let mut tools = Tools::default();
            for job in receiver {
                job(&mut tools);
            }
        });
    if spawned.is_err() {
        eprintln!("[screen] couldn't start the capture worker");
    }
    sender
}

/// Back to the resting state after a question was answered (or failed).
pub fn settle<R: Runtime>(app: &AppHandle<R>) {
    if let Some(coach) = app.try_state::<ScreenCoach>() {
        let mut state = coach.lock();
        if !state.talk_held {
            state.status = coach.resting_status(&state);
        }
    }
    refresh(app);
}

/// Updates the tray (icon, tooltip, menu items) and the settings page to the current state.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let Some(coach) = app.try_state::<ScreenCoach>() else {
        return;
    };
    let (status, on, paused) = {
        let state = coach.lock();
        (state.status, state.config.is_on(), state.config.paused)
    };
    if let Some(tray) = app.tray_by_id(crate::TRAY_ID) {
        let _ = tray.set_tooltip(Some(status.tooltip()));
        if let Some(icon) = app.default_window_icon() {
            let image = match status.badge() {
                Some(colour) => Image::new_owned(
                    with_badge(icon.rgba(), icon.width(), icon.height(), colour),
                    icon.width(),
                    icon.height(),
                ),
                None => icon.clone().to_owned(),
            };
            let _ = tray.set_icon(Some(image));
        }
    }
    if let Some(items) = app.try_state::<TrayItems<R>>() {
        let _ = items.look.set_enabled(on && !paused);
        let _ = items.pause.set_enabled(on);
        let _ = items.pause.set_checked(paused);
        let _ = items
            .stop_walkthrough
            .set_enabled(coach_mode::is_coaching(app));
    }
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        let _ = window.eval(CHANGED_SCRIPT);
    }
}

fn set_paused<R: Runtime>(app: &AppHandle<R>, paused: bool) -> Result<StatusView, String> {
    let coach = app
        .try_state::<ScreenCoach>()
        .ok_or("Screen Coach isn't ready.")?;
    if coach.lock().config.is_on() {
        coach.update(|config| config.paused = paused)?;
        let mut state = coach.lock();
        // A capture in flight finishes its own status update (and drops its frame if paused).
        if state.status != Status::Looking {
            state.status = coach.resting_status(&state);
        }
    }
    if paused {
        // Pausing is a promise: nothing held, nothing captured until resumed (brief §7.10). A
        // walkthrough stops too (saved: it can be continued later).
        coach.slot.clear();
        annotate::clear(app);
        clip::discard(app, None);
        coach_mode::end_quietly(app);
        super::screen_quiz::end_quietly(app);
        circle::end_session(app);
    } else {
        circle::start_tracker(app);
    }
    refresh(app);
    Ok(coach.view())
}

/// Only the bundled settings page may change settings; this re-checks the window on top of
/// the capability (defence in depth).
pub fn require_settings_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let dev_url = window.app_handle().config().build.dev_url.clone();
    let local = window
        .url()
        .is_ok_and(|url| super::is_local_page(&url, dev_url.as_ref()));
    if window.label() == SETTINGS_WINDOW && local {
        Ok(())
    } else {
        Err("Not allowed.".to_owned())
    }
}

pub fn coach_of<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, ScreenCoach>, String> {
    app.try_state::<ScreenCoach>()
        .ok_or_else(|| "Screen Coach isn't ready.".to_owned())
}

#[tauri::command]
pub fn screen_coach_status<R: Runtime>(window: WebviewWindow<R>) -> Result<StatusView, String> {
    require_settings_window(&window)?;
    Ok(coach_of(window.app_handle())?.view())
}

/// Turns Screen Coach on (only with consent to the current explanation) or off.
#[tauri::command]
pub fn screen_coach_set_enabled<R: Runtime>(
    window: WebviewWindow<R>,
    enabled: bool,
    consent_version: u32,
) -> Result<StatusView, String> {
    require_settings_window(&window)?;
    let app = window.app_handle();
    let coach = coach_of(app)?;
    if enabled && coach.support.is_err() {
        return Err("Screen Coach isn't available on this PC.".to_owned());
    }
    if enabled && consent_version != CONSENT_VERSION {
        return Err("Please read how Screen Coach works before turning it on.".to_owned());
    }
    coach.update(|config| {
        config.enabled = enabled;
        if enabled {
            config.consent_version = CONSENT_VERSION;
            config.paused = false;
        }
    })?;
    {
        let mut state = coach.lock();
        state.config_reset = false;
        state.status = coach.resting_status(&state);
    }
    if !enabled {
        coach.slot.clear();
        annotate::clear(app);
        clip::discard(app, None);
        coach_mode::end_quietly(app);
        super::screen_quiz::end_quietly(app);
        circle::end_session(app);
    }
    refresh(app);
    circle::start_tracker(app);
    Ok(coach.view())
}

#[tauri::command]
pub fn screen_coach_set_paused<R: Runtime>(
    window: WebviewWindow<R>,
    paused: bool,
) -> Result<StatusView, String> {
    require_settings_window(&window)?;
    set_paused(window.app_handle(), paused)
}

/// "Got it" on the settings page's "Shortcuts got simpler" card (K2): it isn't shown again.
#[tauri::command]
pub fn screen_coach_shortcuts_seen<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<StatusView, String> {
    require_settings_window(&window)?;
    let app = window.app_handle();
    let coach = coach_of(app)?;
    coach.update(|config| config.shortcuts_notice = false)?;
    refresh(app);
    Ok(coach.view())
}

/// Saves the privacy settings (blocked apps, redaction, capture scope, calls). The whole set is
/// sent each time and checked before it's saved.
#[tauri::command]
pub fn screen_coach_set_privacy<R: Runtime>(
    window: WebviewWindow<R>,
    privacy: Privacy,
) -> Result<StatusView, String> {
    require_settings_window(&window)?;
    let app = window.app_handle();
    let coach = coach_of(app)?;
    let privacy = privacy.normalized()?;
    coach.update(|config| config.privacy = privacy)?;
    refresh(app);
    Ok(coach.view())
}

/// Opens Windows Settings at the microphone privacy page.
#[tauri::command]
pub fn screen_coach_open_mic_settings<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    require_settings_window(&window)?;
    system::open_microphone_settings();
    Ok(())
}

/// Saves Circle & Ask's settings (the pointer, saving, silent mode).
#[tauri::command]
pub fn screen_coach_set_circle<R: Runtime>(
    window: WebviewWindow<R>,
    circle: config::CircleSettings,
) -> Result<StatusView, String> {
    require_settings_window(&window)?;
    let app = window.app_handle();
    let coach = coach_of(app)?;
    coach.update(|config| config.circle = circle)?;
    refresh(app);
    Ok(coach.view())
}
