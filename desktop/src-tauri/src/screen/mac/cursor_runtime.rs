//! Native SHOW ME/CATCH ME runner using shared prediction, lesson, path and catch machines.
//! Pointer coordinates and AX rectangles use Quartz points consistently. Only bounded control
//! summaries reach the planner; all catch facts stay on this device.
use super::{capture_session, input, pipeline, privacy, runtime, service_call, target};
use crate::screen::{
    cursor::{
        catch::{Catcher, Outcome, Rule},
        engine::{Engine, Input},
        euro::EuroParams,
        lesson::{level_for, Effect, Lesson, Level},
        path::{self, PathCache},
        plan::{self, Plan},
        target::{self as targets, TargetSet},
    },
    frame::ScreenRect,
    intent::{self, Intent},
    page,
    sign_in::SignIn,
};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, WebviewWindow};
#[path = "cursor_ax.rs"]
mod ax;
#[path = "cursor_render.rs"]
mod render;

enum Command {
    Start(String, u64),
    Stop,
}
type CurrentAlert = (Rule, String, [u8; 32], u64, Instant);
struct Host {
    sender: mpsc::SyncSender<Command>,
    epoch: Arc<AtomicU64>,
    lesson: Mutex<bool>,
    alert: Mutex<Option<CurrentAlert>>,
}
#[derive(Clone, Copy)]
struct Ticket {
    epoch: u64,
    generation: u64,
    account: [u8; 32],
}
fn owner(app: &AppHandle) -> Option<[u8; 32]> {
    service_call::credential_stamp(app).ok()
}
fn enabled(app: &AppHandle) -> bool {
    runtime::of(app).is_ok_and(|r| {
        let (c, reset) = r.snapshot();
        !reset && c.is_on() && !c.paused && c.privacy.show_in_captures
    })
}
fn current(app: &AppHandle, t: Ticket) -> bool {
    !super::hand::escaped()
        && enabled(app)
        && runtime::of(app).is_ok_and(|r| r.generation.load(Ordering::Acquire) == t.generation)
        && owner(app) == Some(t.account)
        && app
            .try_state::<Host>()
            .is_some_and(|h| h.epoch.load(Ordering::Acquire) == t.epoch)
}
fn ticket(app: &AppHandle) -> Option<Ticket> {
    let host = app.try_state::<Host>()?;
    Some(Ticket {
        epoch: host.epoch.load(Ordering::Acquire),
        generation: runtime::of(app).ok()?.generation.load(Ordering::Acquire),
        account: owner(app)?,
    })
}
pub fn setup(app: &AppHandle) -> Result<(), String> {
    app.add_capability(
        tauri::ipc::CapabilityBuilder::new("mac-cursor-catch")
            .local(true)
            .window(render::CATCH)
            .permission("allow-mac-cursor-catch-action"),
    )
    .map_err(|_| "Couldn't configure catch reminders.")?;
    let (sender, receiver) = mpsc::sync_channel(2);
    let epoch = Arc::new(AtomicU64::new(0));
    if !app.manage(Host {
        sender,
        epoch,
        lesson: Mutex::new(false),
        alert: Mutex::new(None),
    }) {
        return Err("Mac cursor modes already initialized.".into());
    }
    let handle = app.clone();
    std::thread::Builder::new()
        .name("neb-mac-cursor".into())
        .spawn(move || run(&handle, receiver))
        .map_err(|_| "Couldn't start native cursor modes.")?;
    Ok(())
}
pub fn engaged(app: &AppHandle) -> bool {
    app.try_state::<Host>()
        .is_some_and(|h| *h.lesson.lock().unwrap_or_else(|p| p.into_inner()))
}
pub fn stop_all(app: &AppHandle) {
    if let Some(h) = app.try_state::<Host>() {
        h.epoch.fetch_add(1, Ordering::AcqRel);
        let _ = h.sender.try_send(Command::Stop);
        *h.lesson.lock().unwrap_or_else(|p| p.into_inner()) = false;
        *h.alert.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
    render::hide(app);
}
pub fn route_words(app: &AppHandle, text: &str) -> Result<bool, String> {
    route_intent(app, text, intent::intent_of(text, false))
}
pub fn route_intent(app: &AppHandle, text: &str, requested: Intent) -> Result<bool, String> {
    if !matches!(requested, Intent::ShowMe | Intent::Show) {
        return Ok(false);
    }
    if !enabled(app) || owner(app).is_none() {
        return Err("Enable and connect Screen Coach before starting SHOW ME.".into());
    }
    let host = app
        .try_state::<Host>()
        .ok_or("Native cursor modes aren't ready.")?;
    if *host.lesson.lock().unwrap_or_else(|p| p.into_inner()) {
        return Err("A SHOW ME lesson is active. Stop it first.".into());
    }
    let epoch = host.epoch.fetch_add(1, Ordering::AcqRel) + 1;
    super::counts::add(app, "show_me_started");
    host.sender
        .try_send(Command::Start(
            crate::screen::protocol::clean_transcript(text),
            epoch,
        ))
        .map_err(|_| "Native cursor modes are busy.")?;
    *host.lesson.lock().unwrap_or_else(|p| p.into_inner()) = true;
    Ok(true)
}
fn on_main<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&AppHandle) -> Option<T> + Send + 'static,
) -> Option<T> {
    let handle = app.clone();
    let live = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let active = live.clone();
    let deadline = Instant::now() + Duration::from_millis(400);
    let (tx, rx) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        if active.load(Ordering::Acquire) && Instant::now() < deadline {
            let result = f(&handle);
            if active.load(Ordering::Acquire) && Instant::now() < deadline {
                let _ = tx.send(result);
            }
        }
    })
    .ok()?;
    let result = rx
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok()
        .flatten();
    live.store(false, Ordering::Release);
    result
}
fn discover(app: &AppHandle, t: Ticket) -> Option<pipeline::Target> {
    on_main(app, move |app| {
        if !current(app, t) {
            return None;
        }
        let process = privacy::frontmost_process_identity()?;
        let identity = target::AppIdentity {
            pid: process.pid,
            bundle_id: Some(process.bundle_id.clone()),
        };
        let window = target::frontmost_window_candidate(&identity)?;
        Some(pipeline::Target {
            window_id: window.id,
            process,
            quartz_points: window.bounds,
        })
    })
}
fn catch_producer(bundle: &str) -> bool {
    matches!(
        bundle.to_ascii_lowercase().as_str(),
        "com.apple.mail"
            | "com.microsoft.outlook"
            | "com.apple.finder"
            | "com.apple.terminal"
            | "com.googlecode.iterm2"
    )
}
fn catch_metadata_allowed(
    bundle: &str,
    consent: bool,
    blocked: bool,
    ordinary: bool,
    calls_clear: bool,
    binding_current: bool,
) -> bool {
    let known = catch_producer(bundle)
        || super::app_policy::classify_app(bundle) == super::app_policy::AppClass::SupportedNative;
    known && consent && !blocked && ordinary && calls_clear && binding_current
}
/// CATCH ME has separate, explicit local metadata consent. It can observe a known Mail,
/// Finder or terminal producer after user blocklist removal, while screen acquisition and
/// model-driven actions keep their narrower native producer policy.
fn catch_current_main(
    app: &AppHandle,
    t: Ticket,
    target: &pipeline::Target,
    require_catch: bool,
) -> bool {
    if !current(app, t)
        || !(catch_producer(&target.process.bundle_id)
            || super::app_policy::classify_app(&target.process.bundle_id)
                == super::app_policy::AppClass::SupportedNative)
        || !privacy::accessibility_trusted()
    {
        return false;
    }
    let Ok(runtime) = runtime::of(app) else {
        return false;
    };
    let config = runtime.snapshot().0;
    if (require_catch && !config.cursor.catch_me_on())
        || super::app_policy::blocked_app(&target.process.bundle_id, &config.privacy.blocked_apps)
            .is_some()
    {
        return false;
    }
    if privacy::frontmost_process_identity().as_ref() != Some(&target.process) {
        return false;
    }
    let identity = target::AppIdentity {
        pid: target.process.pid,
        bundle_id: Some(target.process.bundle_id.clone()),
    };
    let Some(window) = target::frontmost_window_candidate(&identity) else {
        return false;
    };
    let Some(windows) = target::visible_windows() else {
        return false;
    };
    if windows
        .iter()
        .filter(|w| w.pid == target.process.pid && w.bounds == target.quartz_points && w.layer == 0)
        .count()
        != 1
    {
        return false;
    }
    if window.id != target.window_id
        || window.bounds != target.quartz_points
        || !ax::focused_ordinary(target.process.pid)
    {
        return false;
    }
    if config.privacy.pause_during_calls {
        let deadline = Instant::now() + Duration::from_millis(60);
        let valid = || current(app, t) && Instant::now() < deadline;
        if super::call_signals::sample(deadline, &valid).state
            != super::call_signals::SignalState::KnownSignalsIdle
        {
            return false;
        }
    }
    catch_metadata_allowed(
        &target.process.bundle_id,
        !require_catch || config.cursor.catch_me_on(),
        false,
        true,
        true,
        current(app, t) && privacy::frontmost_process_identity().as_ref() == Some(&target.process),
    )
}
/// Extra mail/terminal/Finder producers are a local-only CATCH ME grant. Remote planning
/// must use the independent screen-privacy gate; this seam cannot acquire or send pixels.
fn metadata_current(
    app: &AppHandle,
    t: Ticket,
    target: &pipeline::Target,
    local_catch: bool,
) -> bool {
    if local_catch {
        let expected = target.clone();
        on_main(app, move |app| {
            Some(catch_current_main(app, t, &expected, true))
        })
        .unwrap_or(false)
    } else {
        capture_session::is_target_current(app, target, t.generation)
    }
}
fn planning_summary(set: &TargetSet) -> Vec<targets::SummaryItem> {
    let rules = crate::screen::privacy::detect::RedactionRules {
        cards: true,
        secrets: true,
        codes: true,
        emails: true,
        phones: true,
    };
    targets::summary(set)
        .into_iter()
        .filter(|item| {
            !matches!(item.control_type.as_str(), "ListItem" | "TreeItem" | "Text")
                && crate::screen::privacy::detect::find_sensitive(&item.name, &rules).is_empty()
        })
        .collect()
}

fn snapshot(
    app: &AppHandle,
    t: Ticket,
    catch: bool,
    catch_context: bool,
) -> Option<(pipeline::Target, ax::Snapshot)> {
    let target = discover(app, t)?;
    if !metadata_current(app, t, &target, catch_context) {
        return None;
    }
    let expected = target.clone();
    let data = on_main(app, move |app| {
        if !current(app, t) {
            return None;
        }
        ax::collect(&expected, catch)
    })?;
    if !current(app, t) || !metadata_current(app, t, &target, catch_context) {
        return None;
    }
    Some((target, data))
}
fn dispatch(app: &AppHandle, t: Ticket, name: &'static str, value: serde_json::Value) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if !current(&handle, t) {
            return;
        }
        if let (Some(w), Some(signin)) = (
            handle.get_webview_window(crate::MAIN),
            handle.try_state::<SignIn>(),
        ) {
            if page::require_app_page(&w, signin.app_url()).is_ok() {
                page::dispatch(&handle, name, value);
            }
        }
    });
}
fn say(app: &AppHandle, t: Ticket, text: &str) {
    dispatch(app, t, page::SAY, json!({"text":text}));
}
fn now_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
fn cache_path(app: &AppHandle, owner: [u8; 32]) -> Option<PathBuf> {
    let suffix = owner[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    Some(
        app.path()
            .app_config_dir()
            .ok()?
            .join(format!("mac-cursor-paths-{suffix}.json")),
    )
}
fn load_cache(app: &AppHandle, t: Ticket) -> PathCache {
    cache_path(app, t.account)
        .and_then(|p| {
            use std::io::Read;
            let mut data = Vec::new();
            std::fs::File::open(p)
                .ok()?
                .take(512 * 1024 + 1)
                .read_to_end(&mut data)
                .ok()?;
            Some(data)
        })
        .filter(|b| b.len() <= 512 * 1024)
        .and_then(|b| String::from_utf8(b).ok())
        .map(|s| PathCache::parse(&s))
        .unwrap_or_else(|| PathCache::parse(""))
}
fn save_cache(app: &AppHandle, t: Ticket, cache: &PathCache) {
    let _guard = PATH_FILES.lock().unwrap_or_else(|p| p.into_inner());
    if !current(app, t) {
        return;
    }
    if let (Some(path), Ok(text)) = (cache_path(app, t.account), serde_json::to_vec(cache)) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() && current(app, t) {
            let _ = std::fs::rename(tmp, path);
        }
    }
}
fn plan(
    app: &AppHandle,
    t: Ticket,
    goal: &str,
    set: &TargetSet,
    prior: Option<&str>,
    happened: Option<&str>,
) -> Result<Plan, String> {
    let request = format!("On macOS: {goal}");
    let body = plan::plan_body(
        plan::Mode::Show,
        &request,
        Some(&set.process),
        &planning_summary(set),
        prior,
        happened,
    );
    let cancelled = || !current(app, t);
    let bytes = service_call::post_bound(app, "api/screen/plan", &body, &t.account, &cancelled)
        .map_err(|e| e.to_string())?;
    let plan = plan::parse_plan(bytes.as_slice())
        .filter(|p| !p.steps.is_empty())
        .ok_or("I couldn't find a safe control path from this window.")?;
    if !current(app, t) {
        return Err("SHOW ME stopped.".into());
    }
    Ok(plan)
}
fn mark_inactive(app: &AppHandle) {
    if let Some(h) = app.try_state::<Host>() {
        *h.lesson.lock().unwrap_or_else(|p| p.into_inner()) = false;
    }
}
fn run(app: &AppHandle, commands: mpsc::Receiver<Command>) {
    let mut lesson: Option<(Lesson, Ticket, Instant, PathCache)> = None;
    let mut engine = Engine::new(EuroParams::default());
    let mut catcher = Catcher::default();
    let mut captured: Option<(pipeline::Target, ax::Snapshot)> = None;
    let mut last_poll = Instant::now() - Duration::from_secs(1);
    let mut last_scene = Instant::now();
    let mut structure = 0u64;
    let started = Instant::now();
    let mut last_pointer = None;
    let mut was_down = false;
    let mut recorder = crate::screen::cursor::trace::Recorder::default();
    loop {
        while let Ok(command) = commands.try_recv() {
            match command {
                Command::Stop => {
                    lesson = None;
                    captured = None;
                    render::hide(app);
                }
                Command::Start(goal, epoch) => {
                    lesson = None;
                    captured = None;
                    let Some(t) = ticket(app).filter(|t| t.epoch == epoch) else {
                        mark_inactive(app);
                        continue;
                    };
                    let Some((target, snap)) = snapshot(app, t, false, false) else {
                        say(app, t, "I couldn't verify the active window for SHOW ME.");
                        mark_inactive(app);
                        continue;
                    };
                    let mut cache = load_cache(app, t);
                    let signature = path::signature(&goal, &snap.set.process);
                    let settings = runtime::of(app).unwrap().snapshot().0.cursor;
                    let known = cache.get(&signature).cloned();
                    let (steps, plan_id) = if let Some(known) = known.as_ref() {
                        (known.steps.clone(), None)
                    } else {
                        match plan(app, t, &goal, &snap.set, None, None) {
                            Ok(p) => {
                                say(app, t, &p.speech);
                                (p.steps, Some(p.plan_id))
                            }
                            Err(e) => {
                                say(app, t, &e);
                                mark_inactive(app);
                                continue;
                            }
                        }
                    };
                    let level = known
                        .as_ref()
                        .map(|p| level_for(p.runs, p.clean_streak, settings.guidance))
                        .unwrap_or(Level::Full);
                    if steps.is_empty() {
                        cache.forget(&signature);
                        mark_inactive(app);
                        continue;
                    }
                    lesson = Some((
                        Lesson::new(signature, goal, plan_id, steps, level),
                        t,
                        Instant::now(),
                        cache,
                    ));
                    captured = Some((target, snap));
                    last_poll = Instant::now();
                    structure = structure.wrapping_add(1);
                }
            }
        }
        if !enabled(app) {
            if lesson.take().is_some() {
                mark_inactive(app);
            }
            captured = None;
            render::hide(app);
            std::thread::park_timeout(Duration::from_millis(100));
            continue;
        }
        let Ok(r) = runtime::of(app) else {
            return;
        };
        let config = r.snapshot().0;
        let catch_enabled = config.cursor.catch_me_on();
        if lesson.is_none()
            && !catch_enabled
            && !config.cursor.debug
            && !config.cursor.record_traces
        {
            captured = None;
            std::thread::park_timeout(Duration::from_millis(100));
            continue;
        }
        if super::ask::engaged(app)
            || super::circle::has_session(app)
            || super::hand::engaged(app)
            || super::study::takes_words(app)
            || super::study::is_coaching(app)
        {
            render::hide(app);
            std::thread::park_timeout(Duration::from_millis(100));
            continue;
        }
        let Some(t) = lesson.as_ref().map(|l| l.1).or_else(|| ticket(app)) else {
            std::thread::park_timeout(Duration::from_millis(100));
            continue;
        };
        if !current(app, t)
            || lesson
                .as_ref()
                .is_some_and(|l| l.2.elapsed() >= Duration::from_secs(15 * 60))
        {
            lesson = None;
            captured = None;
            mark_inactive(app);
            render::hide(app);
            continue;
        }
        if last_poll.elapsed() >= Duration::from_millis(350) {
            let next = snapshot(app, t, catch_enabled, lesson.is_none() && catch_enabled);
            let changed = match (&captured, &next) {
                (Some((before, a)), Some((after, b))) => before != after || a.set != b.set,
                _ => true,
            };
            if changed {
                structure = structure.wrapping_add(1);
            }
            captured = next;
            last_poll = Instant::now();
        }
        let Some((target, snap)) = captured.as_ref() else {
            render::hide(app);
            std::thread::park_timeout(Duration::from_millis(30));
            continue;
        };
        let Some(pointer) = input::cursor() else {
            continue;
        };
        let down = input::left_button_down();
        let clicked = down && !was_down;
        let ms = started.elapsed().as_secs_f64() * 1000.;
        let mut inputs = vec![Input::Tick { t_ms: ms }];
        if last_pointer != Some(pointer) {
            inputs.push(Input::Move {
                t_ms: ms,
                x: pointer.x,
                y: pointer.y,
            });
            last_pointer = Some(pointer);
        }
        if down != was_down {
            inputs.push(if down {
                Input::Down {
                    t_ms: ms,
                    x: pointer.x,
                    y: pointer.y,
                }
            } else {
                Input::Up {
                    t_ms: ms,
                    x: pointer.x,
                    y: pointer.y,
                }
            });
            was_down = down;
        }
        let update = engine.feed(&inputs);
        if config.cursor.record_traces {
            recorder.push(ms, pointer.x, pointer.y);
            if clicked {
                if let Some(trace) = recorder.click(
                    ms,
                    pointer.x,
                    pointer.y,
                    &snap.set.targets,
                    crate::screen::cursor::trace::Device::Mouse,
                ) {
                    save_trace(app, t, &trace);
                }
            }
        } else {
            recorder = crate::screen::cursor::trace::Recorder::default();
        }

        let bounds = target.quartz_points;
        let monitor = ScreenRect {
            left: bounds.x.floor() as i32,
            top: bounds.y.floor() as i32,
            right: (bounds.x + bounds.width).ceil() as i32,
            bottom: (bounds.y + bounds.height).ceil() as i32,
        };
        let mut scene = crate::screen::cursor::scene::Scene::default();
        if config.cursor.debug {
            scene.shapes.extend(
                crate::screen::cursor::engine::debug_scene(
                    &update,
                    &snap.set,
                    &config.cursor.tuning(),
                    monitor,
                    1.,
                    0.,
                )
                .shapes,
            );
        }
        let mut finish = false;
        if let Some((active, t, _, cache)) = lesson.as_mut() {
            let (next, effects) = active.frame(
                &update,
                &snap.set,
                structure,
                ms,
                &config.cursor.tuning(),
                monitor,
                1.,
            );
            scene = next;
            for effect in effects {
                match effect {
                    Effect::Say(text) => say(app, *t, &text),
                    Effect::Cue(cue) => {
                        super::counts::add(app, "show_me_correction");
                        dispatch(app, *t, page::CUE, json!({"cue":cue.key()}));
                    }
                    Effect::Done { clean } => {
                        super::counts::add(app, "show_me_completed");
                        cache.finished(
                            &active.signature,
                            active.steps.clone(),
                            clean,
                            matches!(active.level, Level::CorrectionsOnly | Level::Silent),
                            now_s(),
                        );
                        save_cache(app, *t, cache);
                        finish = true;
                    }
                    Effect::GiveUp(text) => {
                        say(app, *t, &text);
                        finish = true;
                    }
                    Effect::Replan { happened } => {
                        cache.forget(&active.signature);
                        match plan(
                            app,
                            *t,
                            &active.goal,
                            &snap.set,
                            active.plan_id.as_deref(),
                            Some(&happened),
                        ) {
                            Ok(p) => {
                                active.plan_id = Some(p.plan_id);
                                active.replanned(p.steps);
                                say(app, *t, &p.speech);
                            }
                            Err(e) => {
                                active.replan_failed();
                                say(app, *t, &e);
                                finish = true;
                            }
                        }
                    }
                }
            }
        }
        if catch_enabled {
            let enabled = Rule::ALL
                .into_iter()
                .filter(|r| config.cursor.rule_on(r.id(), now_s()))
                .collect::<Vec<_>>();
            let alert = catcher.frame(
                &update,
                &snap.set,
                &snap.facts,
                &enabled,
                &config.cursor.tuning(),
                &config.cursor.not_mistakes,
                ms,
                now_s(),
            );
            let terminal = snap
                .terminal
                .as_ref()
                .and_then(|line| catcher.terminal(line, &enabled, ms, now_s()));
            if let Some(alert) = alert.or(terminal) {
                super::counts::add(app, "catch_shown");
                if let Some(host) = app.try_state::<Host>() {
                    *host.alert.lock().unwrap_or_else(|p| p.into_inner()) = Some((
                        alert.rule,
                        snap.set.process.clone(),
                        t.account,
                        t.epoch,
                        Instant::now(),
                    ));
                }
                let ticket = t;
                render::catch(app, &alert.message, pointer, move |app| {
                    current(app, ticket)
                });
                if config.cursor.voice {
                    say(app, t, &alert.message);
                }
            }
            scene.shapes.extend(
                catcher
                    .scene(Some((pointer.x, pointer.y)), monitor, 1.)
                    .shapes,
            );
        }
        if let Some(host) = app.try_state::<Host>() {
            let expired = {
                let mut alert = host.alert.lock().unwrap_or_else(|p| p.into_inner());
                if alert
                    .as_ref()
                    .is_some_and(|a| a.4.elapsed() > Duration::from_secs(8))
                {
                    alert.take();
                    true
                } else {
                    false
                }
            };
            if expired {
                if let Some(w) = app.get_webview_window(render::CATCH) {
                    let _ = super::overlay::hide(&w);
                }
            }
        }
        if last_scene.elapsed() >= Duration::from_millis(33) {
            let ticket = t;
            render::scene(app, &scene, move |app| current(app, ticket));
            last_scene = Instant::now();
        }
        if finish {
            lesson = None;
            mark_inactive(app);
        }
        std::thread::park_timeout(Duration::from_millis(8));
    }
}

#[tauri::command]
pub fn mac_cursor_catch_action(window: WebviewWindow, action: String) -> Result<(), String> {
    let app = window.app_handle();
    let dev = app.config().build.dev_url.clone();
    if window.label() != render::CATCH
        || !window.url().is_ok_and(|u| {
            crate::screen::is_local_page(&u, dev.as_ref()) && u.path() == "/mac-catch.html"
        })
    {
        return Err("Not allowed.".into());
    }
    let host = app
        .try_state::<Host>()
        .ok_or("Cursor modes aren't ready.")?;
    let alert = host
        .alert
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
        .ok_or("That reminder expired.")?;
    if alert.4.elapsed() > Duration::from_secs(8)
        || owner(app) != Some(alert.2)
        || host.epoch.load(Ordering::Acquire) != alert.3
    {
        return Err("That reminder expired.".into());
    }
    let outcome = match action.as_str() {
        "snooze" => Outcome::Snoozed,
        "not_mistake" => Outcome::NotAMistake,
        "dismiss" => Outcome::Continued,
        _ => return Err("Not allowed.".into()),
    };
    super::counts::add(
        app,
        match outcome {
            Outcome::Snoozed => "catch_snoozed",
            Outcome::NotAMistake => "catch_not_a_mistake",
            _ => "catch_continued",
        },
    );
    runtime::of(app)?.update(|config| {
        match outcome {
            Outcome::Snoozed => {
                config
                    .cursor
                    .snoozed
                    .insert(alert.0.id().into(), now_s() + 15 * 60);
            }
            Outcome::NotAMistake => {
                let key = crate::screen::cursor::catch::sensitivity_key(alert.0, &alert.1);
                let count = config.cursor.not_mistakes.entry(key).or_default();
                *count = count.saturating_add(1);
            }
            _ => {}
        }
        Ok(())
    })?;
    if let Some(w) = app.get_webview_window(render::CATCH) {
        let _ = super::overlay::hide(&w);
    }
    Ok(())
}

static PATH_FILES: Mutex<()> = Mutex::new(());
pub fn forget_paths(app: &AppHandle) -> Result<(), String> {
    let account = owner(app).ok_or("Connect your Neb account first.")?;
    let _guard = PATH_FILES.lock().unwrap_or_else(|p| p.into_inner());
    stop_all(app);
    let path = cache_path(app, account).ok_or("Couldn't locate learned paths.")?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Couldn't delete learned paths.".into()),
    }
}
fn save_trace(app: &AppHandle, t: Ticket, trace: &crate::screen::cursor::trace::Trace) {
    if !current(app, t) {
        return;
    }
    let Some(base) = cache_path(app, t.account) else {
        return;
    };
    let dir = base.with_extension("traces");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect::<Vec<_>>();
    paths.sort();
    for old in paths.iter().take(paths.len().saturating_sub(199)) {
        let _ = std::fs::remove_file(old);
    }
    if let Ok(bytes) = serde_json::to_vec(trace) {
        if bytes.len() <= 512 * 1024 && current(app, t) {
            let _ = std::fs::write(
                dir.join(format!("trace-{}.json", uuid::Uuid::new_v4())),
                bytes,
            );
        }
    }
}
pub fn replay(app: &AppHandle, crumbs: Vec<String>, verb: String) {
    let Some(t) = ticket(app) else {
        return;
    };
    let handle = app.clone();
    let _ = std::thread::Builder::new()
        .name("neb-mac-replay".into())
        .spawn(move || {
            let Some(point) = input::cursor() else {
                return;
            };
            let start = Instant::now();
            let replay = crate::screen::cursor::replay::Replay {
                crumbs: crumbs
                    .into_iter()
                    .take(10)
                    .map(|s| s.chars().take(160).collect())
                    .collect(),
                verb: verb.chars().take(200).collect(),
                started_ms: 0.,
                from: (point.x, point.y),
            };
            while !replay.is_over(start.elapsed().as_secs_f64() * 1000.) && current(&handle, t) {
                let p = point;
                let Some(display) = on_main(&handle, move |_| target::display_at(p)) else {
                    break;
                };
                let r = display.points;
                let bounds = ScreenRect {
                    left: r.x as i32,
                    top: r.y as i32,
                    right: (r.x + r.width) as i32,
                    bottom: (r.y + r.height) as i32,
                };
                let scene = replay.frame(start.elapsed().as_secs_f64() * 1000., bounds, 1.);
                render::scene(&handle, &scene, move |app| current(app, t));
                std::thread::sleep(Duration::from_millis(33));
            }
            if current(&handle, t) {
                render::hide(&handle);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::cursor::{
        catch::{Facts, Rule},
        engine::Update,
        target::{Source, Target},
    };
    fn set(name: &str) -> TargetSet {
        TargetSet {
            process: "fixture.exe".into(),
            targets: vec![Target {
                id: 1,
                name: name.into(),
                control_type: "Button".into(),
                automation_id: "fixture".into(),
                rect: ScreenRect {
                    left: -200,
                    top: 0,
                    right: -100,
                    bottom: 100,
                },
                source: Source::Uia,
            }],
            ..TargetSet::default()
        }
    }
    #[test]
    fn local_catch_metadata_requires_every_positive_boundary() {
        for bundle in [
            "com.apple.Mail",
            "com.microsoft.Outlook",
            "com.apple.finder",
            "com.apple.Terminal",
            "com.googlecode.iterm2",
            "com.apple.TextEdit",
        ] {
            assert!(catch_metadata_allowed(
                bundle, true, false, true, true, true
            ));
            assert!(!catch_metadata_allowed(
                bundle, false, false, true, true, true
            ));
            assert!(!catch_metadata_allowed(
                bundle, true, true, true, true, true
            ));
            assert!(!catch_metadata_allowed(
                bundle, true, false, false, true, true
            ));
            assert!(!catch_metadata_allowed(
                bundle, true, false, true, false, true
            ));
            assert!(!catch_metadata_allowed(
                bundle, true, false, true, true, false
            ));
        }
        for unknown in [
            "org.example.Unknown",
            "com.apple.Safari",
            "com.google.Chrome",
            "com.apple.SecurityAgent",
        ] {
            assert!(!catch_metadata_allowed(
                unknown, true, false, true, true, true
            ));
        }
    }
    #[test]
    fn five_catch_rules_reach_the_shared_machine_from_native_fact_fixtures() {
        let cases = [
            (
                "com.apple.Mail",
                Rule::ReplyAll,
                "Reply All",
                Facts {
                    recipients: 8,
                    ..Facts::default()
                },
            ),
            (
                "com.microsoft.Outlook",
                Rule::Attachment,
                "Send",
                Facts {
                    mentions_attachment: true,
                    ..Facts::default()
                },
            ),
            (
                "com.apple.TextEdit",
                Rule::Unsaved,
                "Close",
                Facts::default(),
            ),
            (
                "com.apple.finder",
                Rule::Delete,
                "Delete",
                Facts {
                    selected_files: 30,
                    ..Facts::default()
                },
            ),
        ];
        for (bundle, rule, label, facts) in cases {
            assert!(catch_metadata_allowed(
                bundle, true, false, true, true, true
            ));
            let mut set = set(label);
            if rule == Rule::Unsaved {
                set.title = "* Draft".into();
            }
            let mut catcher = Catcher::default();
            let update = Update {
                clicks: vec![(-150., 50.)],
                ..Update::default()
            };
            let alert = catcher
                .frame(
                    &update,
                    &set,
                    &facts,
                    &[rule],
                    &Default::default(),
                    &Default::default(),
                    1000.,
                    10,
                )
                .expect("positive native scalar facts trigger the rule");
            assert_eq!(alert.rule, rule);
        }
        assert!(catch_metadata_allowed(
            "com.apple.Terminal",
            true,
            false,
            true,
            true,
            true
        ));
        let mut catcher = Catcher::default();
        assert_eq!(
            catcher
                .terminal("rm -rf ./example", &[Rule::Terminal], 1000., 10)
                .unwrap()
                .rule,
            Rule::Terminal
        );
    }
    #[test]
    fn safe_summary_drops_content_before_planning() {
        let mut set = set("Insert");
        let mut secret = set.targets[0].clone();
        secret.id = 2;
        secret.name = "student@example.com".into();
        secret.control_type = "Edit".into();
        set.targets.push(secret);
        let body = plan::plan_body(
            plan::Mode::Show,
            "show me Insert",
            Some("winword.exe"),
            &targets::summary(&set),
            None,
            None,
        );
        let body = String::from_utf8(body).unwrap();
        assert!(body.contains("Insert"));
        assert!(!body.contains("student@example.com"));
    }
    #[test]
    fn shared_lesson_requires_a_reaction_after_click_before_completion() {
        let mut set = set("Insert");
        let anchor = path::Anchor {
            control_type: "Button".into(),
            name: "Insert".into(),
            automation_id: String::new(),
            process: String::new(),
        };
        let mut lesson = Lesson::new(
            "insert@fixture".into(),
            "Insert".into(),
            None,
            vec![anchor],
            Level::Full,
        );
        let monitor = ScreenRect {
            left: -400,
            top: 0,
            right: 0,
            bottom: 300,
        };
        let update = Update {
            clicks: vec![(-150., 50.)],
            ..Update::default()
        };
        let (_, effects) = lesson.frame(&update, &set, 1, 1000., &Default::default(), monitor, 1.);
        assert!(!effects.iter().any(|e| matches!(e, Effect::Done { .. })));
        let (_, effects) = lesson.frame(
            &Update::default(),
            &set,
            1,
            1400.,
            &Default::default(),
            monitor,
            1.,
        );
        assert!(!effects.iter().any(|e| matches!(e, Effect::Done { .. })));
        set.targets.clear();
        let (_, effects) = lesson.frame(
            &Update::default(),
            &set,
            2,
            1600.,
            &Default::default(),
            monitor,
            1.,
        );
        assert!(effects
            .iter()
            .any(|e| matches!(e, Effect::Done { clean: true })));
    }
}

#[cfg(test)]
mod planning_privacy_tests {
    use super::*;
    #[test]
    fn private_content_rows_never_enter_remote_planning() {
        let mut set = TargetSet::default();
        // Assemble a fake secret so shipped-source scanning can still reject literal keys.
        let fake_secret = ["sk_live_", "123456789012345678901234567890"].concat();
        for (kind, name) in [
            ("ListItem", "Private subject"),
            ("TreeItem", "Private filename"),
            ("Button", fake_secret.as_str()),
            ("Button", "Insert"),
        ] {
            set.targets.push(targets::Target {
                id: set.targets.len() as u32,
                name: name.into(),
                control_type: kind.into(),
                automation_id: String::new(),
                rect: ScreenRect {
                    left: 0,
                    top: 0,
                    right: 10,
                    bottom: 10,
                },
                source: targets::Source::Uia,
            });
        }
        let summary = planning_summary(&set);
        assert_eq!(summary.len(), 1);
        assert_eq!(summary[0].name, "Insert");
    }
}
