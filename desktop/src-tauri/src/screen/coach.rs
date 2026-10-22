//! Screen Coach's runtime on Windows: settings, hotkeys, the tray, and the capture worker.
//!
//! Captures start only here, from the hotkey and tray handlers (decision 2). No command a page
//! can call starts a capture or returns screen pixels. What a capture does, step by step, is in
//! `pipeline.rs`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use tauri::image::Image;
use tauri::ipc::CapabilityBuilder;
use tauri::menu::{CheckMenuItem, MenuItem};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use super::config::{self, HotkeyError, Loaded, Privacy, ScreenConfig, CONSENT_VERSION};
use super::frame::{FrameMeta, FrameSlot, Timings, FRAME_TTL};
use super::pipeline::{self, Captured, Request, ScreenError, Tools};
use super::privacy::blocklist::DEFAULT_BLOCKED_APPS;
use super::privacy::MicAccess;
use super::tray_badge::{with_badge, Status};
use super::win::{self, indicator, system, ComThread, Unsupported};

/// The local settings page's window (and the only window its capability applies to).
pub const SETTINGS_WINDOW: &str = "screen-coach";
const SETTINGS_PAGE: &str = "screen-coach.html";
const CHANGED_SCRIPT: &str = "window.dispatchEvent(new Event('screen-coach:changed'))";

/// Tray menu items Screen Coach keeps up to date.
pub struct TrayItems<R: Runtime> {
    pub look: MenuItem<R>,
    pub pause: CheckMenuItem<R>,
}

pub struct ScreenCoach {
    config_path: PathBuf,
    support: Result<(), Unsupported>,
    state: Mutex<State>,
    slot: FrameSlot,
    worker: Mutex<Sender<Job>>,
    capturing: AtomicBool,
}

struct State {
    config: ScreenConfig,
    /// The settings file was unreadable and was reset (the settings page says so).
    config_reset: bool,
    status: Status,
    talk_held: bool,
    talk: HotkeyReport,
    pause: HotkeyReport,
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
    pub privacy: Privacy,
    pub default_blocked_apps: &'static [&'static str],
    pub microphone: MicAccess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HotkeyKind {
    Talk,
    Pause,
}

/// A capture request for the worker thread, with what to do with the result.
struct Job {
    request: Request,
    done: Box<dyn FnOnce(Result<Captured, ScreenError>) + Send>,
}

impl ScreenCoach {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn view(&self) -> StatusView {
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
            privacy: state.config.privacy.clone(),
            default_blocked_apps: DEFAULT_BLOCKED_APPS,
            microphone: system::mic_access(),
        }
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
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
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
        config,
        config_reset,
        status: Status::Off,
        talk_held: false,
    };
    let coach = ScreenCoach {
        config_path,
        support,
        state: Mutex::new(state),
        slot: FrameSlot::default(),
        worker: Mutex::new(start_worker()),
        capturing: AtomicBool::new(false),
    };
    {
        let mut state = coach.lock();
        state.status = coach.resting_status(&state);
    }
    app.manage(coach);
    settings_capability(app)?;
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
            .permission("allow-screen-coach-open-mic-settings"),
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
    let built =
        WebviewWindowBuilder::new(app, SETTINGS_WINDOW, WebviewUrl::App(SETTINGS_PAGE.into()))
            .title("Mew · Screen Coach")
            .inner_size(600.0, 760.0)
            .min_inner_size(420.0, 520.0)
            // Bundled pages only: the page can't be navigated anywhere else.
            .on_navigation(super::is_local_page)
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
    for report in [&mut state.talk, &mut state.pause] {
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
    if coach.support.is_err() || !state.config.is_on() {
        return;
    }
    for report in [&mut state.talk, &mut state.pause] {
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
    let (is_talk, is_pause) = {
        let state = coach.lock();
        let matches = |report: &HotkeyReport| {
            report.registered
                && config::validate_hotkey(&report.accelerator).is_ok_and(|s| &s == shortcut)
        };
        (matches(&state.talk), matches(&state.pause))
    };
    match (is_talk, is_pause, pressed) {
        (true, _, ShortcutState::Pressed) => {
            coach.lock().talk_held = true;
            ask(app);
        }
        (true, _, ShortcutState::Released) => {
            let mut state = coach.lock();
            state.talk_held = false;
            if state.status == Status::Listening {
                state.status = coach.resting_status(&state);
            }
            drop(state);
            // S2 sends the question with the held frame here.
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
    ask(app);
}

/// Captures the screen for a question: only when Screen Coach is on, not paused, and not
/// already capturing. The privacy checks themselves run in the pipeline.
fn ask<R: Runtime>(app: &AppHandle<R>) {
    let Some(coach) = app.try_state::<ScreenCoach>() else {
        return;
    };
    let request = {
        let mut state = coach.lock();
        if coach.support.is_err() || !state.config.is_on() || state.config.paused {
            return;
        }
        if coach.capturing.swap(true, Ordering::SeqCst) {
            return;
        }
        state.status = Status::Looking;
        Request {
            scope: state.config.privacy.ask_scope,
            privacy: state.config.privacy.clone(),
        }
    };
    refresh(app);

    let handle = app.clone();
    let job = Job {
        request,
        done: Box::new(move |result| finish_capture(&handle, result)),
    };
    let sent = coach
        .worker
        .lock()
        .map(|worker| worker.send(job).is_ok())
        .unwrap_or(false);
    if !sent {
        // The worker died (it never should): start a new one for next time.
        if let Ok(mut worker) = coach.worker.lock() {
            *worker = start_worker();
        }
        finish_capture(app, Err(ScreenError::Failed));
    }
}

/// Keeps the frame (and shows the indicator) or tells the user why there's none.
fn finish_capture<R: Runtime>(app: &AppHandle<R>, result: Result<Captured, ScreenError>) {
    let Some(coach) = app.try_state::<ScreenCoach>() else {
        return;
    };
    coach.capturing.store(false, Ordering::SeqCst);
    match result {
        Ok(Captured { jpeg, meta }) => {
            log_capture(&meta, jpeg.len());
            let (monitor, dpi) = (meta.monitor, meta.dpi);
            // A pause pressed mid-capture wins: the frame is dropped (and wiped).
            if coach.lock().config.paused {
                drop(jpeg);
            } else {
                coach.slot.put(jpeg, meta, Instant::now());
                indicator::flash(monitor, dpi);
                schedule_expiry(app);
            }
        }
        Err(error) => notify(app, &error.message()),
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

fn notify<R: Runtime>(app: &AppHandle<R>, message: &str) {
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
            let com = ComThread::init();
            let mut tools = Tools::default();
            for Job { request, done } in receiver {
                let result = match &com {
                    Ok(_) => pipeline::run(&mut tools, &request),
                    Err(_) => Err(ScreenError::Failed),
                };
                done(result);
            }
        });
    if spawned.is_err() {
        eprintln!("[screen] couldn't start the capture worker");
    }
    sender
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
        // Pausing is a promise: nothing held, nothing captured until resumed (brief §7.10).
        coach.slot.clear();
    }
    refresh(app);
    Ok(coach.view())
}

/// Only the bundled settings page may change settings; this re-checks the window on top of
/// the capability (defence in depth).
fn require_settings_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let local = window.url().is_ok_and(|url| super::is_local_page(&url));
    if window.label() == SETTINGS_WINDOW && local {
        Ok(())
    } else {
        Err("Not allowed.".to_owned())
    }
}

fn coach_of<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, ScreenCoach>, String> {
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
        let other = match which {
            HotkeyKind::Talk => &state.config.hotkeys.pause,
            HotkeyKind::Pause => &state.config.hotkeys.talk,
        };
        if config::validate_hotkey(other).is_ok_and(|s| s == shortcut) {
            return Err(
                "That shortcut is already used by the other Screen Coach action.".to_owned(),
            );
        }
        if crate::is_summon_hotkey(&shortcut) {
            return Err("That shortcut already summons Mew. Choose a different one.".to_owned());
        }
    }
    // Check it's free before switching, so a taken shortcut never leaves the user with none.
    let shortcuts = app.global_shortcut();
    let already_ours = {
        let state = coach.lock();
        [&state.talk, &state.pause].iter().any(|report| {
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
