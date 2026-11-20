//! The cursor modes at run time (docs/CURSOR_MODES.md): one engine thread that runs only while a
//! mode needs it, owning the mouse hook, the UI Automation watcher and the cursor layer.
//!
//! - The thread runs while Screen Coach is usable and a mode is wanted: the debug view, CATCH ME
//!   (on, with its consent), or a SHOW ME lesson or DO IT replay in progress. It ends itself when
//!   none is left.
//! - Inside it, the mouse hook runs only when something needs the pointer: the debug view, a
//!   lesson, a replay, or CATCH ME with a risky control in the window in front. Otherwise it's
//!   unhooked and the thread waits on its command channel.
//! - Each frame (120 Hz while the hook runs): drain the hook, run the pure engine, let each mode
//!   turn the update into a scene and effects, draw the scene, carry out the effects.
//!
//! Nothing it reads (positions, control names) is logged, saved or sent, except a SHOW ME or
//! DO IT plan's control summary (`target::summary`) and the paths that worked, kept on this
//! computer (`cursor-paths.json`: control types and names only).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;
use tauri::{AppHandle, Manager, Runtime};

use super::coach;
use super::cursor::catch::{self, Alert, Catcher, LogEntry, Outcome, Rule};
use super::cursor::engine::{debug_scene, Engine, Input, Update};
use super::cursor::euro::EuroParams;
use super::cursor::lesson::{level_for, Effect, Lesson, Level};
use super::cursor::path::{self, Anchor, PathCache};
use super::cursor::plan::{parse_plan, plan_body, Mode, Plan};
use super::cursor::replay::Replay;
use super::cursor::scene::{Scene, Shape};
use super::cursor::settings::CursorSettings;
use super::cursor::target::{self, TargetSet};
use super::cursor::telemetry::Counts;
use super::cursor::trace::{Device, Recorder};
use super::device_call::{self, CallError};
use super::frame::ScreenRect;
use super::page;
use super::pipeline::Captured;
use super::privacy::blocklist::is_blocked;
use super::win::catch_chip;
use super::win::catch_facts::{is_terminal_app, FactsWorker, Request};
use super::win::cursor_layer::{list_monitors, CursorLayer};
use super::win::mouse_stream::{now_ms, MouseEvent, MouseStream};
use super::win::uia_targets::{TargetWatcher, Targets};

/// The frame interval while the pointer is followed (120 Hz).
const FRAME: Duration = Duration::from_micros(8_333);
/// How long the thread waits for a command when nothing needs the pointer.
const IDLE_WAIT: Duration = Duration::from_millis(250);
/// How long `show_me` waits for the thread to say whether it can teach this.
const SHOW_ME_DECIDE: Duration = Duration::from_millis(2500);
/// A lesson ends by itself after this long.
const LESSON_MAX: Duration = Duration::from_secs(300);
/// The same request again this soon after a lesson shows everything (the student asked).
const ASKED_AGAIN: Duration = Duration::from_secs(120);

/// Work for the engine thread.
pub enum Command {
    /// Settings changed (or Screen Coach was paused): re-read them.
    Settings,
    Stop,
    /// SHOW ME: can a lesson for `goal` start here? (`reply` says yes or no at once.)
    ShowMe {
        goal: String,
        reply: Sender<bool>,
    },
    /// A plan (or a re-plan) came back.
    Planned {
        signature: String,
        goal: String,
        level: Level,
        replan: bool,
        result: Result<Plan, CallError>,
    },
    /// "Forget learned paths" (the settings page).
    ForgetPaths,
    /// DO IT finished: show where things are.
    Replay(Replay),
}

/// Kept in Tauri's state: the running thread's channel, if any.
#[derive(Default)]
pub struct CursorRuntime {
    running: Mutex<Option<(u64, Sender<Command>)>>,
    epoch: AtomicU64,
    /// Counts only (telemetry): interventions shown, accepted, dismissed; lessons finished;
    /// chores and undos. Never what was on screen.
    counts: Mutex<Option<Counts>>,
}

impl CursorRuntime {
    fn running(&self) -> std::sync::MutexGuard<'_, Option<(u64, Sender<Command>)>> {
        self.running.lock().unwrap_or_else(|p| p.into_inner())
    }
}

pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    app.manage(CursorRuntime::default());
    refresh(app);
}

/// CATCH ME paused from the tray (until resumed, or the app restarts).
static CATCH_PAUSED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn catch_paused() -> bool {
    CATCH_PAUSED.load(Ordering::SeqCst)
}

/// The tray's "Pause CATCH ME": one click pauses it, another resumes it.
pub fn toggle_catch_pause<R: Runtime>(app: &AppHandle<R>) {
    CATCH_PAUSED.fetch_xor(true, Ordering::SeqCst);
    coach::refresh(app);
}

/// CATCH ME is watching: on, with its consent, and not paused from the tray.
pub fn catch_active(settings: &CursorSettings) -> bool {
    settings.catch_me_on() && !catch_paused()
}

/// Whether the settings alone want the thread (a lesson or replay keeps it too).
fn wanted(settings: &CursorSettings) -> bool {
    settings.debug || settings.record_traces || catch_active(settings)
}

/// Starts or stops the engine thread to match the settings and Screen Coach's state; tells a
/// running one to re-read its settings. Called from `coach::refresh`. Paused or off, the thread
/// stops, and any lesson with it (pausing is a promise).
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let Some(runtime) = app.try_state::<CursorRuntime>() else {
        return;
    };
    let usable = coach::is_usable(app);
    let want = usable && wanted(&coach::cursor_settings(app));
    let mut running = runtime.running();
    match running.as_ref() {
        Some((_, sender)) if !usable => {
            let _ = sender.send(Command::Stop);
            *running = None;
        }
        Some((_, sender)) => {
            if sender.send(Command::Settings).is_err() {
                *running = None;
                if want {
                    *running = start(app, &runtime);
                }
            }
        }
        None if want => *running = start(app, &runtime),
        None => {}
    }
}

/// The running thread's channel, starting the thread if needed (a lesson asked for one).
fn ensure_running<R: Runtime>(app: &AppHandle<R>) -> Option<Sender<Command>> {
    if !coach::is_usable(app) {
        return None;
    }
    let runtime = app.try_state::<CursorRuntime>()?;
    let mut running = runtime.running();
    if running.is_none() {
        *running = start(app, &runtime);
    }
    running.as_ref().map(|(_, s)| s.clone())
}

fn send<R: Runtime>(app: &AppHandle<R>, command: Command) {
    if let Some(sender) = ensure_running(app) {
        let _ = sender.send(command);
    }
}

fn start<R: Runtime>(
    app: &AppHandle<R>,
    runtime: &CursorRuntime,
) -> Option<(u64, Sender<Command>)> {
    let epoch = runtime.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let (sender, receiver) = mpsc::channel();
    let handle = app.clone();
    std::thread::Builder::new()
        .name("mew-cursor-engine".into())
        .spawn(move || {
            run(&handle, receiver);
            // Ended by itself (nothing wanted): forget the channel, if it's still ours.
            if let Some(runtime) = handle.try_state::<CursorRuntime>() {
                let mut running = runtime.running();
                if running.as_ref().is_some_and(|(e, _)| *e == epoch) {
                    *running = None;
                }
            }
        })
        .ok()?;
    Some((epoch, sender))
}

/// SHOW ME for `goal` ("how do I turn on dark mode?"). True when a lesson is starting (from a
/// path that worked before, or planned now); false when the window in front exposes no
/// controls to guide to (the caller falls back to Neb's hand or a question).
pub fn show_me<R: Runtime>(app: &AppHandle<R>, goal: &str) -> bool {
    // "Show me how", just after a chore: the same request as a lesson.
    let plain = goal.trim().trim_end_matches(['.', '?', '!']).to_lowercase();
    let after_chore = matches!(
        plain.as_str(),
        "show me how" | "show me how to do that" | "show me how you did that"
    );
    let goal = if after_chore {
        match super::cursor_do::recent_goal() {
            Some(recent) => recent,
            None => return false,
        }
    } else {
        goal.to_owned()
    };
    let goal = goal.as_str();
    let Some(sender) = ensure_running(app) else {
        return false;
    };
    let (reply, answer) = mpsc::channel();
    if sender
        .send(Command::ShowMe {
            goal: goal.trim().to_owned(),
            reply,
        })
        .is_err()
    {
        return false;
    }
    answer.recv_timeout(SHOW_ME_DECIDE).unwrap_or(false)
}

/// DO IT for `goal` (`cursor_do.rs`).
pub fn do_it<R: Runtime>(app: &AppHandle<R>, goal: String, captured: Captured) {
    super::cursor_do::start(app, goal, captured);
}

/// DO IT's replay: about two seconds of Neb's ghost cursor and a caption of where things are.
pub fn replay<R: Runtime>(app: &AppHandle<R>, crumbs: Vec<String>, verb: String, from: (f64, f64)) {
    send(
        app,
        Command::Replay(Replay {
            crumbs,
            verb,
            started_ms: now_ms(),
            from,
        }),
    );
}

fn counts_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join(super::cursor::telemetry::COUNTS_FILE))
}

/// Adds one to a telemetry count (kept on this computer; counts only).
pub fn count<R: Runtime>(app: &AppHandle<R>, key: &str) {
    let Some(runtime) = app.try_state::<CursorRuntime>() else {
        return;
    };
    let path = counts_path(app);
    let mut counts = runtime.counts.lock().unwrap_or_else(|p| p.into_inner());
    let counts = counts.get_or_insert_with(|| {
        path.as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .map(|t| Counts::parse(&t))
            .unwrap_or_default()
    });
    counts.add(key);
    if let (Some(path), Ok(text)) = (path, serde_json::to_string(&*counts)) {
        let _ = std::fs::write(path, text);
    }
}

/// The counts so far (the settings page shows them).
pub fn counts<R: Runtime>(app: &AppHandle<R>) -> Counts {
    counts_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|t| Counts::parse(&t))
        .unwrap_or_default()
}

/// "Forget learned paths": the cache file goes, and the running thread's copy.
pub fn forget_paths<R: Runtime>(app: &AppHandle<R>) {
    if let Some(path) = cache_path(app) {
        let _ = std::fs::remove_file(path);
    }
    if let Some(runtime) = app.try_state::<CursorRuntime>() {
        if let Some((_, sender)) = runtime.running().as_ref() {
            let _ = sender.send(Command::ForgetPaths);
        }
    }
}

fn cache_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join(path::CACHE_FILE))
}

fn load_cache<R: Runtime>(app: &AppHandle<R>) -> PathCache {
    cache_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|t| PathCache::parse(&t))
        .unwrap_or_else(|| PathCache::parse(""))
}

fn save_cache<R: Runtime>(app: &AppHandle<R>, cache: &PathCache) {
    let (Some(path), Ok(text)) = (cache_path(app), serde_json::to_string(cache)) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let temp = path.with_extension("json.tmp");
    if std::fs::write(&temp, text).is_ok() {
        let _ = std::fs::rename(&temp, &path);
    }
}

fn now_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Says a sentence through the page's voice.
fn say<R: Runtime>(app: &AppHandle<R>, text: &str) {
    page::dispatch(app, page::SAY, json!({ "text": text }));
}

/// Says a pre-generated word ("below", "done") in the student's language.
fn cue<R: Runtime>(app: &AppHandle<R>, key: &str) {
    page::dispatch(app, page::CUE, json!({ "cue": key }));
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

/// A lesson in progress, with when it started.
struct Running {
    lesson: Lesson,
    started: Instant,
}

/// Everything the thread owns.
struct World<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    live: Live,
    watcher: &'a TargetWatcher,
    targets: Targets,
    lesson: Option<Running>,
    /// DO IT's replay in progress.
    replay: Option<Replay>,
    /// A plan is on its way for this request.
    planning: bool,
    cache: PathCache,
    /// The last lesson's request and when it started (asked again soon: show everything).
    last_lesson: Option<(String, Instant)>,
    /// CATCH ME.
    catch: CatchRun,
}

/// CATCH ME's part of the thread: its rules' state, the facts worker, the chip's answers.
struct CatchRun {
    catcher: Catcher,
    facts: Option<FactsWorker>,
    /// What the facts were last asked for: (window, generation, when).
    asked: (isize, u64, Instant),
    /// The window's guarded controls whose condition holds now (the pointer is followed).
    risky: bool,
    terminal_at: Instant,
    chip: (Sender<Outcome>, Receiver<Outcome>),
    /// The catch the chip is about: its rule and the app.
    shown: Option<(Rule, String)>,
}

impl Default for CatchRun {
    fn default() -> Self {
        Self {
            catcher: Catcher::default(),
            facts: None,
            asked: (0, u64::MAX, Instant::now()),
            risky: false,
            terminal_at: Instant::now(),
            chip: mpsc::channel(),
            shown: None,
        }
    }
}

/// How often the facts are read again while a guarded control is on screen (drafts change
/// without the window's structure changing).
const FACTS_EVERY: Duration = Duration::from_millis(1500);
/// How often a terminal's typed line is looked at, while a terminal is in front.
const TERMINAL_EVERY: Duration = Duration::from_millis(300);

fn run<R: Runtime>(app: &AppHandle<R>, commands: Receiver<Command>) {
    // The blocked apps, read again with the settings: a blocked app is never read at all.
    let blocked = Arc::new(Mutex::new(coach::privacy_of(app).blocked_apps));
    let filter_list = Arc::clone(&blocked);
    let Some(watcher) = TargetWatcher::start(Arc::new(move |app: &str| {
        !is_blocked(app, &filter_list.lock().unwrap_or_else(|p| p.into_inner()))
    })) else {
        eprintln!("[cursor] UI Automation unavailable; cursor modes are off");
        return;
    };
    let live_now = live(app);
    let Some(layer) = CursorLayer::start(live_now.show_in_captures) else {
        return;
    };
    let mut world = World {
        app,
        live: live_now,
        targets: watcher.targets(),
        watcher: &watcher,
        lesson: None,
        replay: None,
        planning: false,
        cache: load_cache(app),
        last_lesson: None,
        catch: CatchRun::default(),
    };
    let mut engine = Engine::new(EuroParams::default());
    let mut hook: Option<MouseStream> = None;
    let mut events: Vec<MouseEvent> = Vec::with_capacity(64);
    let mut inputs: Vec<Input> = Vec::with_capacity(64);
    let mut monitors = list_monitors();
    let mut monitors_at = Instant::now();
    let mut shown = Scene::default();
    let mut frame_ms = 0.0;
    let mut recorder = Recorder::default();
    let traces_dir = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("cursor-traces"));

    loop {
        world.catch_tick();
        let needs_pointer = world.live.settings.debug
            || world.live.settings.record_traces
            || world.lesson.is_some()
            || world.replay.is_some()
            || world.catch.risky
            || world.catch.catcher.alert.is_some();
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
                world.live = live(app);
                layer.set_shown_in_captures(world.live.show_in_captures);
                *blocked.lock().unwrap_or_else(|p| p.into_inner()) =
                    coach::privacy_of(app).blocked_apps;
                continue;
            }
            Ok(command) => {
                world.handle(command);
                continue;
            }
            Err(RecvTimeoutError::Timeout) => {
                // Nothing pending, nothing in progress, nothing wanted: done.
                let busy = world.lesson.is_some() || world.planning || world.replay.is_some();
                if !busy && !wanted(&world.live.settings) {
                    break;
                }
            }
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
        let now = now_ms();
        inputs.push(Input::Tick { t_ms: now });
        let update = engine.feed(&inputs);
        let set = world.targets.latest();
        let generation = world.targets.generation();
        if world.live.settings.record_traces {
            record(&mut recorder, &events, &set.targets, traces_dir.as_deref());
        }
        if monitors_at.elapsed() > Duration::from_secs(2) {
            monitors = list_monitors();
            monitors_at = Instant::now();
        }
        let (monitor, scale) = monitor_of(&update, &monitors);

        let mut scene = Scene::default();
        let params = world.live.settings.tuning();
        if world.live.settings.debug {
            scene
                .shapes
                .extend(debug_scene(&update, &set, &params, monitor, scale, frame_ms).shapes);
        }
        scene
            .shapes
            .extend(world.lesson_frame(&update, &set, generation, now, monitor, scale));
        if let Some(replay) = &world.replay {
            if replay.is_over(now) {
                world.replay = None;
            } else {
                let (m, s) = monitor_at(replay.from, &monitors).unwrap_or((monitor, scale));
                scene.shapes.extend(replay.frame(now, m, s).shapes);
            }
        }
        if catch_active(&world.live.settings) {
            world.catch_frame(&update, &set, now, monitor, scale);
            let cursor = update
                .kin
                .map(|k| (k.x, k.y))
                .or_else(|| super::win::input::cursor().map(|(x, y)| (f64::from(x), f64::from(y))));
            scene
                .shapes
                .extend(world.catch.catcher.scene(cursor, monitor, scale).shapes);
        }
        if scene != shown {
            layer.show(scene.clone());
            shown = scene;
        }
        // The pipeline's own time (input, prediction, modes, scene), shown in the debug view.
        frame_ms = started.elapsed().as_secs_f64() * 1000.0;
    }
    layer.clear();
    drop(hook);
}

fn monitor_at(at: (f64, f64), monitors: &[(ScreenRect, f32)]) -> Option<(ScreenRect, f32)> {
    monitors
        .iter()
        .find(|(m, _)| m.contains(at.0 as i32, at.1 as i32))
        .copied()
}

fn monitor_of(update: &Update, monitors: &[(ScreenRect, f32)]) -> (ScreenRect, f32) {
    update
        .kin
        .and_then(|k| {
            monitors
                .iter()
                .find(|(m, _)| m.contains(k.x as i32, k.y as i32))
                .copied()
        })
        .unwrap_or((ScreenRect::default(), 1.0))
}

/// The rules turned on now (not off, not snoozed).
fn enabled_rules(settings: &CursorSettings) -> Vec<Rule> {
    let now = now_s();
    Rule::ALL
        .into_iter()
        .filter(|r| settings.rule_on(r.id(), now))
        .collect()
}

/// Appends a catch's outcome to the log (rule, app, time, outcome; nothing else).
fn log_catch<R: Runtime>(app: &AppHandle<R>, entry: LogEntry) {
    let Some(path) = app
        .path()
        .app_config_dir()
        .ok()
        .map(|d| d.join(catch::LOG_FILE))
    else {
        return;
    };
    let mut log: Vec<LogEntry> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    log.push(entry);
    let excess = log.len().saturating_sub(catch::LOG_MAX);
    log.drain(..excess);
    if let Ok(text) = serde_json::to_string(&log) {
        let _ = std::fs::write(path, text);
    }
}

impl<R: Runtime> World<'_, R> {
    /// CATCH ME between frames: which guarded controls apply (asking for fresh facts when the
    /// window changed), the terminal's typed line, and the chip's answers.
    fn catch_tick(&mut self) {
        if !catch_active(&self.live.settings) {
            self.catch.risky = false;
            self.catch.catcher.alert = None;
            self.catch.facts = None;
            return;
        }
        // Taken out while it's used (put back at the end), so the rest of the state stays free.
        let Some(facts) = self.catch.facts.take().or_else(FactsWorker::start) else {
            self.catch.risky = false;
            return;
        };
        self.catch_with(&facts);
        self.catch.facts = Some(facts);
    }

    fn catch_with(&mut self, facts: &FactsWorker) {
        let enabled = enabled_rules(&self.live.settings);
        let set = self.targets.latest();
        let generation = self.targets.generation();
        let guarded = catch::guarded(&set, &enabled);
        let rules: Vec<Rule> = guarded
            .iter()
            .map(|(r, _)| *r)
            .filter(|r| matches!(r, Rule::ReplyAll | Rule::Attachment | Rule::Delete))
            .collect();
        let (window, asked_gen, asked_at) = self.catch.asked;
        if !rules.is_empty()
            && (window != set.window || asked_gen != generation || asked_at.elapsed() > FACTS_EVERY)
        {
            facts.ask(Request {
                window: set.window,
                generation,
                rules,
            });
            self.catch.asked = (set.window, generation, Instant::now());
        }
        let answer = facts.latest();
        let known = if answer.window == set.window {
            answer.facts
        } else {
            catch::Facts::default()
        };
        let now = now_s();
        self.catch.risky = !catch::live_risks(&set, &known, &enabled, |r| {
            self.catch.catcher.may_fire(r, now)
        })
        .is_empty();
        // The terminal: the line being typed, before Enter.
        if enabled.contains(&Rule::Terminal)
            && is_terminal_app(&set.process)
            && self.catch.terminal_at.elapsed() >= TERMINAL_EVERY
        {
            self.catch.terminal_at = Instant::now();
            // The line asked for last time (the next is asked now): never waited for.
            let line = facts.take_line();
            facts.ask_line();
            if let Some(line) = line {
                if let Some(alert) = self.catch.catcher.terminal(&line, &enabled, now_ms(), now) {
                    let process = set.process.clone();
                    self.catch_fired(alert, &process, None);
                }
            }
        }
        // The chip's answer.
        while let Ok(outcome) = self.catch.chip.1.try_recv() {
            let Some((rule, process)) = self.catch.shown.take() else {
                continue;
            };
            self.catch.catcher.alert = None;
            log_catch(self.app, LogEntry::new(rule, &process, now, outcome));
            match outcome {
                Outcome::Continued => count(self.app, "catch_continued"),
                Outcome::NotAMistake => {
                    count(self.app, "catch_not_a_mistake");
                    let key = catch::sensitivity_key(rule, &process);
                    let _ = coach::update_cursor(self.app, |c| {
                        *c.not_mistakes.entry(key).or_insert(0) += 1;
                    });
                }
                Outcome::Snoozed => {
                    count(self.app, "catch_snoozed");
                    let _ = coach::update_cursor(self.app, |c| {
                        c.snoozed.insert(rule.id().to_owned(), now + 3600);
                    });
                }
                Outcome::Shown => {}
            }
        }
    }

    /// CATCH ME in a frame (the pointer is being followed).
    fn catch_frame(
        &mut self,
        update: &Update,
        set: &TargetSet,
        now: f64,
        monitor: ScreenRect,
        scale: f32,
    ) {
        let Some(facts) = &self.catch.facts else {
            return;
        };
        let answer = facts.latest();
        let known = if answer.window == set.window {
            answer.facts
        } else {
            catch::Facts::default()
        };
        let enabled = enabled_rules(&self.live.settings);
        let params = self.live.settings.tuning();
        if let Some(alert) = self.catch.catcher.frame(
            update,
            set,
            &known,
            &enabled,
            &params,
            &self.live.settings.not_mistakes,
            now,
            now_s(),
        ) {
            let cursor = update.kin.map(|k| (k.x as i32, k.y as i32));
            let process = set.process.clone();
            self.catch_fired(alert, &process, cursor.map(|c| (c, monitor, scale)));
        }
    }

    /// A catch: said once, shown in amber, and the chip offered beside it.
    fn catch_fired(
        &mut self,
        alert: Alert,
        process: &str,
        at: Option<((i32, i32), ScreenRect, f32)>,
    ) {
        count(self.app, "catch_shown");
        say(self.app, &alert.message);
        let (cursor, monitor, scale) = at.unwrap_or_else(|| {
            let cursor = super::win::input::cursor().unwrap_or((0, 0));
            let (monitor, scale) = list_monitors()
                .into_iter()
                .find(|(m, _)| m.contains(cursor.0, cursor.1))
                .unwrap_or((ScreenRect::default(), 1.0));
            (cursor, monitor, scale)
        });
        self.catch.shown = Some((alert.rule, process.to_owned()));
        // No room clear of the control: the caption and the voice say it, without a chip.
        match catch_chip::place(cursor, alert.rect, monitor, scale) {
            Some(place) => catch_chip::show(
                place,
                scale,
                alert.message.clone(),
                self.live.show_in_captures,
                self.catch.chip.0.clone(),
            ),
            None => {
                let _ = self.catch.chip.0.send(Outcome::Shown);
            }
        }
    }

    fn handle(&mut self, command: Command) {
        match command {
            Command::ShowMe { goal, reply } => {
                let _ = reply.send(self.start_lesson(goal));
            }
            Command::Planned {
                signature,
                goal,
                level,
                replan,
                result,
            } => self.planned(signature, goal, level, replan, result),
            Command::ForgetPaths => self.cache = PathCache::parse(""),
            Command::Replay(replay) => self.replay = Some(replay),
            Command::Settings | Command::Stop => {}
        }
    }

    /// The window in front's controls, collected fresh (at most ~0.8 s).
    fn fresh_targets(&self) -> Arc<TargetSet> {
        let before = self.targets.generation();
        self.watcher.refresh_now();
        let until = Instant::now() + Duration::from_millis(800);
        while self.targets.generation() == before && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(15));
        }
        self.targets.latest()
    }

    /// Starts a lesson for `goal` from a path that worked before, or asks for a plan. False if
    /// the window in front can't be guided through.
    fn start_lesson(&mut self, goal: String) -> bool {
        let set = self.fresh_targets();
        if set.process.is_empty() || set.targets.is_empty() {
            return false;
        }
        let signature = path::signature(&goal, &set.process);
        let known = self.cache.get(&signature).cloned();
        let asked_again = self
            .last_lesson
            .as_ref()
            .is_some_and(|(s, at)| *s == signature && at.elapsed() < ASKED_AGAIN);
        let level = if asked_again {
            Level::Full
        } else {
            known.as_ref().map_or(Level::Full, |k| {
                level_for(k.runs, k.clean_streak, self.live.settings.guidance)
            })
        };
        self.last_lesson = Some((signature.clone(), Instant::now()));
        // A path that worked before, still on screen: no plan needed (and no question spent).
        if let Some(known) =
            known.filter(|k| !k.steps.is_empty() && path::resolve(&k.steps[0], &set).is_some())
        {
            self.begin(Lesson::new(signature, goal, None, known.steps, level));
            return true;
        }
        let controls = target::summary(&set);
        if controls.is_empty() {
            return false;
        }
        let body = plan_body(Mode::Show, &goal, Some(&set.process), &controls, None, None);
        self.plan(body, signature, goal, level, false);
        true
    }

    fn begin(&mut self, lesson: Lesson) {
        if lesson.level == Level::Silent {
            // They know this one; it's watched (to count practice), never drawn or corrected.
            cue(self.app, "go_ahead");
        }
        self.lesson = Some(Running {
            lesson,
            started: Instant::now(),
        });
    }

    /// Asks for a plan on its own thread; the answer comes back as `Command::Planned`.
    fn plan(&mut self, body: Vec<u8>, signature: String, goal: String, level: Level, replan: bool) {
        self.planning = true;
        let app = self.app.clone();
        let spawned = std::thread::Builder::new()
            .name("mew-cursor-plan".into())
            .spawn(move || {
                let result = device_call::post(&app, "api/screen/plan", "plan", &body)
                    .and_then(|bytes| parse_plan(&bytes).ok_or(CallError::Failed));
                send(
                    &app,
                    Command::Planned {
                        signature,
                        goal,
                        level,
                        replan,
                        result,
                    },
                );
            });
        if spawned.is_err() {
            self.planning = false;
        }
    }

    fn planned(
        &mut self,
        signature: String,
        goal: String,
        level: Level,
        replan: bool,
        result: Result<Plan, CallError>,
    ) {
        self.planning = false;
        let plan = match result {
            Ok(plan) => plan,
            Err(error) => {
                let message = match error {
                    CallError::Account(m) | CallError::Limited(m) => m,
                    CallError::Busy => "Lots of questions right now. Try again in a moment.".into(),
                    CallError::Failed => {
                        "I couldn't plan that just now. Try again in a moment.".into()
                    }
                };
                coach::notify(self.app, &message);
                self.lesson = None;
                return;
            }
        };
        if plan.steps.is_empty() {
            // It can't be shown from here: the plan's own words say why.
            say(self.app, &plan.speech);
            self.lesson = None;
            return;
        }
        say(self.app, &plan.speech);
        match (replan, self.lesson.as_mut()) {
            (true, Some(running)) => {
                running.lesson.plan_id = Some(plan.plan_id);
                running.lesson.replanned(plan.steps);
            }
            (true, None) => {}
            (false, _) => self.begin(Lesson::new(
                signature,
                goal,
                Some(plan.plan_id),
                plan.steps,
                level,
            )),
        }
    }

    /// The lesson's frame: its scene, with its effects carried out.
    fn lesson_frame(
        &mut self,
        update: &Update,
        set: &TargetSet,
        generation: u64,
        now: f64,
        monitor: ScreenRect,
        scale: f32,
    ) -> Vec<Shape> {
        let Some(running) = self.lesson.as_mut() else {
            return Vec::new();
        };
        if running.started.elapsed() > LESSON_MAX {
            self.lesson = None;
            return Vec::new();
        }
        let params = self.live.settings.tuning();
        let (scene, effects) = running
            .lesson
            .frame(update, set, generation, now, &params, monitor, scale);
        for effect in effects {
            self.effect(effect);
        }
        scene.shapes
    }

    fn effect(&mut self, effect: Effect) {
        match effect {
            Effect::Say(text) => say(self.app, &text),
            Effect::Cue(word) => {
                count(self.app, "show_me_correction");
                if self.live.settings.voice {
                    cue(self.app, word.key());
                }
            }
            Effect::Replan { happened } => {
                let Some(running) = self.lesson.as_ref() else {
                    return;
                };
                let set = self.targets.latest();
                let controls = target::summary(&set);
                let lesson = &running.lesson;
                let body = plan_body(
                    Mode::Show,
                    &lesson.goal,
                    Some(&set.process),
                    &controls,
                    lesson.plan_id.as_deref(),
                    Some(&happened),
                );
                let (signature, goal, level) =
                    (lesson.signature.clone(), lesson.goal.clone(), lesson.level);
                // A cached path that led astray is planned afresh next time.
                if lesson.plan_id.is_none() {
                    self.cache.forget(&signature);
                    save_cache(self.app, &self.cache);
                }
                self.plan(body, signature, goal, level, true);
            }
            Effect::Done { clean } => {
                count(self.app, "show_me_completed");
                if let Some(running) = self.lesson.take() {
                    let lesson = running.lesson;
                    let steps: Vec<Anchor> = lesson.steps.clone();
                    self.cache.finished(
                        &lesson.signature,
                        steps,
                        clean,
                        lesson.level == Level::CorrectionsOnly,
                        now_s(),
                    );
                    save_cache(self.app, &self.cache);
                    if lesson.level != Level::Silent {
                        cue(self.app, "done");
                    }
                }
            }
            Effect::GiveUp(message) => {
                say(self.app, &message);
                if let Some(running) = self.lesson.take() {
                    self.cache.forget(&running.lesson.signature);
                    save_cache(self.app, &self.cache);
                }
            }
        }
    }
}

/// The debug view's trace recorder: positions and rectangles only, to a local folder.
fn record(
    recorder: &mut Recorder,
    events: &[MouseEvent],
    targets: &[super::cursor::target::Target],
    dir: Option<&std::path::Path>,
) {
    for event in events {
        match *event {
            MouseEvent::Move { t_ms, x, y } => recorder.push(t_ms, x, y),
            MouseEvent::Down { t_ms, x, y } => {
                let Some(trace) = recorder.click(t_ms, x, y, targets, Device::Mouse) else {
                    continue;
                };
                let (Some(dir), Ok(json)) = (dir, serde_json::to_string(&trace)) else {
                    continue;
                };
                if std::fs::create_dir_all(dir).is_ok() {
                    let name = format!("trace-{}.json", t_ms.round() as u64);
                    let _ = std::fs::write(dir.join(name), json);
                }
            }
            _ => {}
        }
    }
}
