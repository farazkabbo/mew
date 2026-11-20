//! The cursor modes at run time (docs/CURSOR_MODES.md): one engine thread that runs only while a
//! mode needs it, owning the mouse hook, the UI Automation watcher and the cursor layer.
//!
//! - The thread runs while Screen Coach is usable and a mode is wanted: the debug view, CATCH ME
//!   (on, with its consent), or a SHOW ME lesson or DO IT replay in progress.
//! - Inside it, the mouse hook runs only when something needs the pointer: the debug view, a
//!   lesson, or CATCH ME with a risky control in the window in front. Otherwise it's unhooked and
//!   the thread waits on its command channel (CATCH ME's idle cost is the UIA watcher's events).
//! - Each frame (120 Hz while the hook runs): drain the hook, run the pure engine, let each mode
//!   turn the update into a scene and effects, draw the scene, carry out the effects.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime};

use super::coach;
use super::cursor::engine::{debug_scene, Engine, Input};
use super::cursor::euro::EuroParams;
use super::cursor::scene::Scene;
use super::cursor::settings::CursorSettings;
use super::frame::ScreenRect;
use super::privacy::blocklist::is_blocked;
use super::win::cursor_layer::{list_monitors, CursorLayer};
use super::win::mouse_stream::{now_ms, MouseEvent, MouseStream};
use super::win::uia_targets::TargetWatcher;

/// The frame interval while the pointer is followed (120 Hz).
const FRAME: Duration = Duration::from_micros(8_333);
/// How long the thread waits for a command when nothing needs the pointer.
const IDLE_WAIT: Duration = Duration::from_millis(250);

/// Work for the engine thread.
pub enum Command {
    /// Settings changed (or Screen Coach was paused): re-read them.
    Settings,
    Stop,
}

/// Kept in Tauri's state: the running thread's channel, if any.
#[derive(Default)]
pub struct CursorRuntime {
    running: Mutex<Option<Sender<Command>>>,
}

impl CursorRuntime {
    fn sender(&self) -> std::sync::MutexGuard<'_, Option<Sender<Command>>> {
        self.running.lock().unwrap_or_else(|p| p.into_inner())
    }
}

pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    app.manage(CursorRuntime::default());
    refresh(app);
}

/// Whether any mode wants the thread now.
fn wanted(settings: &CursorSettings) -> bool {
    settings.debug || settings.catch_me_on()
}

/// Starts or stops the engine thread to match the settings and Screen Coach's state; tells a
/// running one to re-read its settings. Called from `coach::refresh`.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let Some(runtime) = app.try_state::<CursorRuntime>() else {
        return;
    };
    let settings = coach::cursor_settings(app);
    let want = coach::is_usable(app) && wanted(&settings);
    let mut running = runtime.sender();
    match (want, running.as_ref()) {
        (true, Some(sender)) => {
            if sender.send(Command::Settings).is_err() {
                *running = start(app);
            }
        }
        (true, None) => *running = start(app),
        (false, Some(sender)) => {
            let _ = sender.send(Command::Stop);
            *running = None;
        }
        (false, None) => {}
    }
}

fn start<R: Runtime>(app: &AppHandle<R>) -> Option<Sender<Command>> {
    let (sender, receiver) = mpsc::channel();
    let handle = app.clone();
    std::thread::Builder::new()
        .name("mew-cursor-engine".into())
        .spawn(move || run(handle, receiver))
        .ok()?;
    Some(sender)
}

/// The settings the thread works from (re-read on `Command::Settings`).
struct Live {
    settings: CursorSettings,
    show_in_captures: bool,
}

fn live<R: Runtime>(app: &AppHandle<R>) -> Live {
    Live {
        settings: coach::cursor_settings(app),
        show_in_captures: coach::privacy_of(app).show_in_captures,
    }
}

fn run<R: Runtime>(app: AppHandle<R>, commands: Receiver<Command>) {
    let mut live = live(&app);
    // The blocked apps, read again with the settings: a blocked app is never read at all.
    let blocked = Arc::new(Mutex::new(coach::privacy_of(&app).blocked_apps));
    let filter_list = Arc::clone(&blocked);
    let Some(watcher) = TargetWatcher::start(Arc::new(move |app: &str| {
        !is_blocked(app, &filter_list.lock().unwrap_or_else(|p| p.into_inner()))
    })) else {
        eprintln!("[cursor] UI Automation unavailable; cursor modes are off");
        return;
    };
    let targets = watcher.targets();
    let Some(layer) = CursorLayer::start(live.show_in_captures) else {
        return;
    };
    let mut engine = Engine::new(EuroParams::default());
    let mut hook: Option<MouseStream> = None;
    let mut events: Vec<MouseEvent> = Vec::with_capacity(64);
    let mut inputs: Vec<Input> = Vec::with_capacity(64);
    let mut monitors = list_monitors();
    let mut monitors_at = Instant::now();
    let mut shown = Scene::default();
    let mut frame_ms = 0.0;

    loop {
        let needs_pointer = live.settings.debug;
        if needs_pointer && hook.is_none() {
            hook = MouseStream::start();
            engine = Engine::new(EuroParams::default());
        } else if !needs_pointer && hook.is_some() {
            hook = None;
            layer.clear();
            shown = Scene::default();
        }

        let wait = if hook.is_some() { FRAME } else { IDLE_WAIT };
        match commands.recv_timeout(wait) {
            Ok(Command::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Ok(Command::Settings) => {
                live = live_with(&app, &layer, &blocked);
                continue;
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        let Some(stream) = &hook else {
            continue;
        };
        let started = Instant::now();
        events.clear();
        stream.drain(&mut events);
        inputs.clear();
        inputs.extend(events.iter().map(|e| match *e {
            MouseEvent::Move { t_ms, x, y } => Input::Move { t_ms, x, y },
            MouseEvent::Down { t_ms, x, y } => Input::Down { t_ms, x, y },
            MouseEvent::Up { t_ms, x, y } => Input::Up { t_ms, x, y },
            MouseEvent::Secondary { t_ms } => Input::Secondary { t_ms },
        }));
        inputs.push(Input::Tick { t_ms: now_ms() });
        let update = engine.feed(&inputs);
        let set = targets.latest();

        if monitors_at.elapsed() > Duration::from_secs(2) {
            monitors = list_monitors();
            monitors_at = Instant::now();
        }
        let (monitor, scale) = update
            .kin
            .and_then(|k| {
                monitors
                    .iter()
                    .find(|(m, _)| m.contains(k.x as i32, k.y as i32))
                    .copied()
            })
            .unwrap_or((ScreenRect::default(), 1.0));

        let mut scene = Scene::default();
        if live.settings.debug {
            let params = live.settings.tuning();
            scene
                .shapes
                .extend(debug_scene(&update, &set, &params, monitor, scale, frame_ms).shapes);
        }
        if scene != shown {
            layer.show(scene.clone());
            shown = scene;
        }
        // The pipeline's own time (input, prediction, scene), shown in the debug view.
        frame_ms = started.elapsed().as_secs_f64() * 1000.0;
    }
    layer.clear();
    drop(hook);
    drop(watcher);
}

fn live_with<R: Runtime>(
    app: &AppHandle<R>,
    layer: &CursorLayer,
    blocked: &Arc<Mutex<Vec<String>>>,
) -> Live {
    let next = live(app);
    layer.set_shown_in_captures(next.show_in_captures);
    *blocked.lock().unwrap_or_else(|p| p.into_inner()) = coach::privacy_of(app).blocked_apps;
    next
}
