//! Screen Coach's runtime on Windows: settings, hotkeys, the tray, and the capture worker.
//!
//! Captures start only here, from the hotkey and tray handlers (decision 2). No command a page
//! can call starts a capture or returns screen pixels. What a capture does, step by step, is in
//! `pipeline.rs`; asking about it is in `ask.rs`; connecting to the account in `account.rs`;
//! ink on screen in `annotate.rs` and saving clips in `clip.rs` (S3); walkthroughs in
//! `coach_mode.rs` (S4).

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
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use super::account::PendingLink;
use super::annotate::{self, InkState};
use super::ask;
use super::clip::{self, ClipDraft, Purpose};
use super::coach_mode::{self, CoachCapture, CoachState};
use super::config::{
    self, CaptureScope, HotkeyError, Loaded, Privacy, ScreenConfig, CONSENT_VERSION,
};
use super::frame::{CapturedFrame, FrameMeta, FrameSlot, Timings, FRAME_TTL};
use super::notes_check;
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
    /// The walkthrough in progress, as far as the desktop knows it (S4).
    coaching: Mutex<CoachState>,
}

struct State {
    config: ScreenConfig,
    /// The settings file was unreadable and was reset (the settings page says so).
    config_reset: bool,
    status: Status,
    talk_held: bool,
    /// The page is listening for this hold of the talk hotkey (a capture started for it).
    hold_active: bool,
    /// A device token is saved: Screen Coach can ask the server.
    connected: bool,
    talk: HotkeyReport,
    pause: HotkeyReport,
    clip: HotkeyReport,
    notes: HotkeyReport,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyReport {
    pub accelerator: String,
    pub registered: bool,
    /// Why it isn't registered, in words for the settings page.
    pub problem: Option<String>,
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
    pub talk: HotkeyReport,
    pub pause: HotkeyReport,
    pub clip: HotkeyReport,
    pub notes: HotkeyReport,
    pub privacy: Privacy,
    pub default_blocked_apps: &'static [&'static str],
    pub microphone: MicAccess,
    /// Connected to the user's Mew account (a device token is saved).
    pub connected: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HotkeyKind {
    Talk,
    Pause,
    Clip,
    Notes,
}

/// Who asked for a capture: the hold-to-talk hotkey (the page listens, then asks with the
/// words), the tray (asked at once, without words), saving a clip (S3), the Notes Check hotkey
/// (compared with the notes at once), or the progress pill's Done, Hint and Resume (S4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Origin {
    Hotkey,
    Tray,
    Clip(Purpose),
    NotesCheck,
    Coach(CoachCapture),
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
            talk: state.talk.clone(),
            pause: state.pause.clone(),
            clip: state.clip.clone(),
            notes: state.notes.clone(),
            privacy: state.config.privacy.clone(),
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

    pub fn coaching(&self) -> std::sync::MutexGuard<'_, CoachState> {
        self.coaching
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
    let report = |accelerator: &str| HotkeyReport {
        accelerator: accelerator.to_owned(),
        ..Default::default()
    };
    let state = State {
        talk: report(&config.hotkeys.talk),
        pause: report(&config.hotkeys.pause),
        clip: report(&config.hotkeys.clip),
        notes: report(&config.hotkeys.notes),
        config,
        config_reset,
        status: Status::Off,
        talk_held: false,
        hold_active: false,
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
        coaching: Mutex::new(CoachState::default()),
    };
    {
        let mut state = coach.lock();
        state.status = coach.resting_status(&state);
    }
    app.manage(coach);
    settings_capability(app)?;
    overlay_capabilities(app)?;
    sync_hotkeys(app);
    refresh(app);
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
            .permission("allow-screen-coach-set-hotkey")
            .permission("allow-screen-coach-set-privacy")
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
            .title("Mew · Screen Coach")
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

/// Registers the hotkeys Screen Coach needs right now (none while it's off).
fn sync_hotkeys<R: Runtime>(app: &AppHandle<R>) {
    let Some(coach) = app.try_state::<ScreenCoach>() else {
        return;
    };
    let shortcuts = app.global_shortcut();
    let mut guard = coach.lock();
    let state = &mut *guard;
    for report in [
        &mut state.talk,
        &mut state.pause,
        &mut state.clip,
        &mut state.notes,
    ] {
        if report.registered {
            if let Ok(shortcut) = config::validate_hotkey(&report.accelerator) {
                let _ = shortcuts.unregister(shortcut);
            }
            report.registered = false;
        }
        report.problem = None;
    }
    state.talk.accelerator = state.config.hotkeys.talk.clone();
    state.pause.accelerator = state.config.hotkeys.pause.clone();
    state.clip.accelerator = state.config.hotkeys.clip.clone();
    state.notes.accelerator = state.config.hotkeys.notes.clone();
    if coach.support.is_err() || !state.config.is_on() {
        return;
    }
    for report in [
        &mut state.talk,
        &mut state.pause,
        &mut state.clip,
        &mut state.notes,
    ] {
        match config::validate_hotkey(&report.accelerator) {
            Ok(shortcut) => match shortcuts.register(shortcut) {
                Ok(()) => report.registered = true,
                Err(_) => {
                    report.problem = Some(format!(
                        "Another app is already using {}. Choose a different shortcut.",
                        report.accelerator
                    ))
                }
            },
            Err(error) => report.problem = Some(hotkey_problem(error).to_owned()),
        }
    }
}

fn hotkey_problem(error: HotkeyError) -> &'static str {
    match error {
        HotkeyError::Invalid => {
            "That isn't a shortcut I understand. Try something like Ctrl+Alt+Space."
        }
        HotkeyError::NeedsModifier => {
            "Shortcuts need Ctrl or Alt, so normal typing never triggers them."
        }
        HotkeyError::UsesWinKey => {
            "Windows reserves shortcuts with the Windows key. Use Ctrl or Alt instead."
        }
        HotkeyError::ReservedBySystem => {
            "Windows already uses that shortcut. Choose a different one."
        }
    }
}

/// Called for every global shortcut that isn't the summon hotkey.
pub fn on_shortcut<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut, pressed: ShortcutState) {
    let Some(coach) = app.try_state::<ScreenCoach>() else {
        return;
    };
    // Esc is only registered while ink is on screen.
    if shortcut == &annotate::escape() {
        if pressed == ShortcutState::Pressed {
            annotate::clear(app);
        }
        return;
    }
    let (is_talk, is_pause, is_clip, is_notes) = {
        let state = coach.lock();
        let matches = |report: &HotkeyReport| {
            report.registered
                && config::validate_hotkey(&report.accelerator).is_ok_and(|s| &s == shortcut)
        };
        (
            matches(&state.talk),
            matches(&state.pause),
            matches(&state.clip),
            matches(&state.notes),
        )
    };
    if is_notes {
        if pressed == ShortcutState::Pressed && usable(&coach) {
            capture(app, Origin::NotesCheck, None);
        }
        return;
    }
    if is_clip {
        if pressed == ShortcutState::Pressed && usable(&coach) {
            clip::on_hotkey(app);
        }
        return;
    }
    match (is_talk, is_pause, pressed) {
        (true, _, ShortcutState::Pressed) => {
            coach.lock().talk_held = true;
            if capture(app, Origin::Hotkey, None) {
                coach.lock().hold_active = true;
                page::dispatch(app, page::LISTEN, serde_json::Value::Null);
            }
        }
        (true, _, ShortcutState::Released) => {
            let mut state = coach.lock();
            state.talk_held = false;
            let was_listening = std::mem::take(&mut state.hold_active);
            if state.status == Status::Listening {
                state.status = coach.resting_status(&state);
            }
            drop(state);
            // The page finishes hearing the question and asks with it (`screen_coach_ask`).
            if was_listening {
                page::dispatch(app, page::RELEASE, serde_json::Value::Null);
            }
            refresh(app);
        }
        (_, true, ShortcutState::Pressed) => toggle_pause(app),
        _ => {}
    }
}

/// "Pause Screen Coach" from the tray or the pause hotkey.
pub fn toggle_pause<R: Runtime>(app: &AppHandle<R>) {
    let Some(coach) = app.try_state::<ScreenCoach>() else {
        return;
    };
    let paused = coach.lock().config.paused;
    if set_paused(app, !paused).is_err() {
        notify(app, "Couldn't save Screen Coach settings.");
    }
}

/// "Look at my screen" from the tray.
pub fn look_from_tray<R: Runtime>(app: &AppHandle<R>) {
    capture(app, Origin::Tray, None);
}

/// Captures the screen to clip from (S3): to re-place the earlier ink on, or to drag a region
/// out of. Only from the clip hotkey, the pill or "save this" (decision 2).
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

/// On, not paused, on a supported PC: the hotkeys may act.
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
            notify(app, "Connect Screen Coach to your Mew account first: tray → Screen Coach settings → Connect.");
            return false;
        }
        if coach.capturing.swap(true, Ordering::SeqCst) {
            return false;
        }
        state.status = Status::Looking;
        // During a walkthrough the hotkey sees the monitor: menus and dialogs are often separate
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
/// is asked about at once; a hotkey capture waits for the page to send the words.
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
    let mut for_notes = None;
    let mut for_coach = None;
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
                    Origin::NotesCheck => for_notes = Some(captured),
                    Origin::Coach(kind) => for_coach = Some((kind, captured)),
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
    if let Some(captured) = for_notes {
        notes_check::start(app, captured, false);
    }
    if let Some((kind, captured)) = for_coach {
        coach_mode::on_captured(app, kind, captured);
    }
    match (origin, kept) {
        (Origin::Tray, true) => ask::ask_in_background(app, String::new()),
        (Origin::Hotkey, false) => {
            coach.lock().hold_active = false;
            page::dispatch(app, page::CANCEL, serde_json::Value::Null);
        }
        (Origin::Coach(_), false) => coach_mode::capture_failed(app),
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
    }
    sync_hotkeys(app);
    refresh(app);
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

/// Changes a hotkey. The new one must be valid and free; otherwise the old one stays.
#[tauri::command]
pub fn screen_coach_set_hotkey<R: Runtime>(
    window: WebviewWindow<R>,
    which: HotkeyKind,
    accelerator: String,
) -> Result<StatusView, String> {
    require_settings_window(&window)?;
    let app = window.app_handle();
    let coach = coach_of(app)?;
    let accelerator: String = accelerator
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect();
    let shortcut =
        config::validate_hotkey(&accelerator).map_err(|e| hotkey_problem(e).to_owned())?;
    let normalised = shortcut.to_string();
    {
        let state = coach.lock();
        let hotkeys = &state.config.hotkeys;
        let others: [&String; 3] = match which {
            HotkeyKind::Talk => [&hotkeys.pause, &hotkeys.clip, &hotkeys.notes],
            HotkeyKind::Pause => [&hotkeys.talk, &hotkeys.clip, &hotkeys.notes],
            HotkeyKind::Clip => [&hotkeys.talk, &hotkeys.pause, &hotkeys.notes],
            HotkeyKind::Notes => [&hotkeys.talk, &hotkeys.pause, &hotkeys.clip],
        };
        if others
            .iter()
            .any(|other| config::validate_hotkey(other).is_ok_and(|s| s == shortcut))
        {
            return Err("That shortcut is already used by another Screen Coach action.".to_owned());
        }
        if crate::is_summon_hotkey(&shortcut) {
            return Err("That shortcut already summons Mew. Choose a different one.".to_owned());
        }
    }
    // Check it's free before switching, so a taken shortcut never leaves the user with none.
    let shortcuts = app.global_shortcut();
    let already_ours = {
        let state = coach.lock();
        [&state.talk, &state.pause, &state.clip, &state.notes]
            .iter()
            .any(|report| {
                report.registered
                    && config::validate_hotkey(&report.accelerator).is_ok_and(|s| s == shortcut)
            })
    };
    if !already_ours {
        shortcuts.register(shortcut).map_err(|_| {
            format!("Another app is already using {accelerator}. Choose a different shortcut.")
        })?;
        let _ = shortcuts.unregister(shortcut);
    }
    coach.update(|config| match which {
        HotkeyKind::Talk => config.hotkeys.talk = normalised,
        HotkeyKind::Pause => config.hotkeys.pause = normalised,
        HotkeyKind::Clip => config.hotkeys.clip = normalised,
        HotkeyKind::Notes => config.hotkeys.notes = normalised,
    })?;
    sync_hotkeys(app);
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
