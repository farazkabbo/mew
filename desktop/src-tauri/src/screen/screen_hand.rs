//! Neb's hand: the student asks Neb to do something on their screen ("open the Insert tab",
//! "click that for me", "scroll down to the references") and Neb's own cursor, a violet arrow
//! beside theirs, goes and does it, one visible action at a time. Asked where something is
//! ("where can I sign out in VS Code?", `Mode::Show`), it opens what hides it and ends with its
//! cursor resting on the thing, pressing nothing.
//!
//! One look, one action: the screen (through the usual privacy pipeline) and the goal go to
//! `POST /api/screen/act`, which answers the single next action; Neb says it, its cursor glides
//! there and acts, then it looks again, until the server says it's done. Neb's cursor and the
//! student's mouse are two separate things: Neb's click is a touch tap, which lands without
//! moving the mouse (`win::mouse`), so the student keeps theirs the whole time.
//!
//! A long task ("research the water cycle and save it in a doc") is the same loop, many times.
//! The model finds its own route, and keeps two things between looks, which live here in
//! memory until the run ends: its `plan` and its `notes` (what it read, and where). When a
//! document is ready it asks for the writing (`screen_write::start_for_hand`, with the notes as
//! the material), and carries on when the typing ends (`after_write`), to name and save it.
//!
//! - **Off until the student turns it on** in Settings ("Let Neb click for me"),
//!   and only ever started by their own words.
//! - **The student stops it at any time**: pressing Esc stops it at once, as does pausing
//!   Screen Coach.
//! - **It never presses** anything whose name says it buys, sends, deletes, signs in, installs
//!   or agrees to something (`risky_label`; the server refuses the same list): it points at it
//!   and says it's theirs to press. It never types or presses keys in a terminal or a system
//!   window, never types into a password field, and types one short line at most. Its keys are
//!   a fixed list (`win::mouse::PlainKey`): nothing that closes, deletes, pastes or runs.
//! - At most `MAX_STEPS` actions and `MAX_TIME` for one request.
//!
//! Pure parts (the body, the reply, the list of controls it leaves alone, the glide) are at the
//! bottom and tested.

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Runtime};

use super::coach;
use super::device_call::{self, CallError};
use super::frame::{FrameMeta, ScreenRect};
use super::overlay::{self, Surface};
use super::page;
use super::pipeline::Captured;
use super::privacy::Focus;
use super::protocol::{is_uuid, with_image, within, Point, SPEECH_CHARS};
use super::screen_island;
use super::secret::SecretBytes;
use super::win::input::{cursor, escape_pressed, foreground};
use super::win::launch;
use super::win::mouse::{self, Button, PlainKey};
use super::win::typing::{Typed, Typist};

/// Actions for one request, at most (mirrors packages/shared/src/screen-act.ts).
pub const MAX_STEPS: u32 = 80;
/// How long one request may go on for.
const MAX_TIME: Duration = Duration::from_secs(15 * 60);
/// Neb's own memory between looks: its plan, and the notes it keeps.
const PLAN_CHARS: usize = 600;
const NOTES: usize = 30;
const NOTE_CHARS: usize = 800;
const HISTORY_ITEMS: usize = 20;
const HISTORY_CHARS: usize = 160;
const LABEL_CHARS: usize = 80;
const TYPE_CHARS: usize = 200;
/// What to write, handed to Neb's typing (a spoken request's length).
const REQUEST_CHARS: usize = 500;
const SCROLL_NOTCHES: i32 = 10;
/// After an action, before looking again: menus open, pages scroll, tabs switch.
const SETTLE: Duration = Duration::from_millis(500);
/// A look that got no answer (the model busy, the network) is asked again this many times,
/// this far apart: long enough in all for the server's own 20-second pause to pass.
const RETRIES: u32 = 4;
const RETRY_WAIT: Duration = Duration::from_secs(8);
/// After opening an app or an address: its window takes a moment to come up.
const OPENING: Duration = Duration::from_millis(2500);
/// A "wait": a page loading, an app starting.
const WAIT: Duration = Duration::from_millis(1500);
/// How long Neb's cursor rests on what it was asked to show, in steps of `REST_STEP`.
const REST: Duration = Duration::from_secs(8);
const REST_STEP: Duration = Duration::from_millis(100);
/// The glide of Neb's cursor to its next spot: frames, and the time each lasts.
const GLIDE_FRAMES: u32 = 22;
const GLIDE_FRAME: Duration = Duration::from_millis(16);
/// The cursor's window, in CSS pixels, and where the arrow's tip is in it.
const HAND_SIZE: f64 = 40.0;
const HAND_TIP: f64 = 4.0;
const HAND_LOOK: &str = "mew:hand-look";

/// What was asked for (mirrors `ScreenActMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Carry the request out.
    #[default]
    Do,
    /// Find the thing and point at it, without pressing it.
    Show,
}

#[derive(Default)]
struct HandState {
    on: bool,
    mode: Mode,
    /// Bumped at every start and stop: a look or a reply from before belongs to an older run.
    generation: u64,
    goal: String,
    /// What's been done so far, in Neb's own words (sent with each look).
    history: Vec<String>,
    steps: u32,
    /// Where Neb's own cursor is.
    at: (i32, i32),
    /// The place to write is ready: the next look goes to Neb's typing, with this request.
    write: Option<String>,
    /// What's left to do, in the model's words at its last look.
    plan: String,
    /// What the model chose to keep of what it read, oldest first. Never saved or logged.
    notes: Vec<String>,
    started: Option<Instant>,
}

static STATE: Mutex<HandState> = Mutex::new(HandState {
    on: false,
    mode: Mode::Do,
    generation: 0,
    goal: String::new(),
    history: Vec::new(),
    steps: 0,
    at: (0, 0),
    write: None,
    plan: String::new(),
    notes: Vec::new(),
    started: None,
});

fn state() -> MutexGuard<'static, HandState> {
    STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Neb's hand is doing something.
pub fn active() -> bool {
    state().on
}

/// "Open the Insert tab", "click that for me" (`Mode::Do`), "where can I sign out?"
/// (`Mode::Show`): the captured screen and what was said.
pub fn start<R: Runtime>(app: &AppHandle<R>, transcript: String, mode: Mode, captured: Captured) {
    if !coach::hand_allowed(app) {
        coach::notify(
            app,
            "I can do that for you once you turn on “Let Neb click for me” in Settings. They're open now.",
        );
        coach::open_settings(app);
        return;
    }
    // A terminal or a system window in front: not there. An app Windows can't name (the
    // desktop, a system surface) is fine to start from, since Neb can open what it needs;
    // typing and keys are checked against the app in front when they happen.
    if let Some(reason) = captured
        .meta
        .app
        .as_deref()
        .and_then(|named| refused_app(Some(named)))
    {
        coach::notify(app, reason);
        return;
    }
    let Some(home) = cursor() else {
        coach::notify(app, "I couldn't find the mouse just now. Try again.");
        return;
    };
    let generation = {
        let mut s = state();
        s.on = true;
        s.mode = mode;
        s.generation += 1;
        s.goal = transcript;
        s.history.clear();
        s.steps = 0;
        s.at = home;
        s.write = None;
        s.plan.clear();
        s.notes.clear();
        s.started = Some(Instant::now());
        s.generation
    };
    // Esc's "pressed since" bit is cleared, so only a press from now on stops it.
    let _ = escape_pressed();
    show_hand(app, home);
    screen_island::refresh(app);
    // The question's picture may be of one window; Neb's hand works with the whole monitor
    // (the taskbar, other windows, menus), so it looks again before its first action.
    drop(captured);
    let _ = generation;
    if !coach::capture_for_hand(app) {
        stop(
            app,
            Some("I couldn't look at your screen just now. Try again."),
        );
    }
}

/// Stops Neb's hand (`notice`: said why): its cursor goes.
pub fn stop<R: Runtime>(app: &AppHandle<R>, notice: Option<&str>) {
    {
        let mut s = state();
        if !s.on {
            return;
        }
        s.on = false;
        s.generation += 1;
        s.history.clear();
        s.goal.clear();
        s.write = None;
        s.plan.clear();
        s.notes.clear();
        s.started = None;
    }
    overlay::hide_quietly_named(app, Surface::Hand);
    if let Some(notice) = notice {
        coach::notify(app, notice);
    }
    screen_island::refresh(app);
    coach::settle(app);
}

/// The capture for the next look arrived.
pub fn on_captured<R: Runtime>(app: &AppHandle<R>, captured: Captured) {
    let (generation, write) = {
        let mut s = state();
        if !s.on {
            return; // wiped unsent
        }
        let write = s.write.take().map(|request| (request, s.notes.join("\n")));
        (s.generation, write)
    };
    // The document is ready: Neb's typing writes what was asked there, from the notes kept on
    // the way, and the hand carries on when it ends (`after_write`).
    if let Some((request, material)) = write {
        look(app, "thinking");
        super::screen_write::start_for_hand(app, request, material, captured);
        return;
    }
    act_in_background(app, generation, captured);
}

/// The writing Neb's hand asked for has ended (`all`: every word was typed). It looks again and
/// carries on with what's left (naming and saving the document); if the typing was stopped or
/// failed, which has been said, so does the hand.
pub fn after_write<R: Runtime>(app: &AppHandle<R>, all: bool) {
    if !all {
        return stop(app, None);
    }
    let generation = {
        let mut s = state();
        if !s.on {
            return;
        }
        s.history.push("Wrote it into the document.".to_owned());
        if s.history.len() > HISTORY_ITEMS {
            s.history.remove(0);
        }
        s.steps += 1;
        s.generation
    };
    look_again(app, generation);
}

/// After an action: waits for the screen to settle and asks for the next look, unless the run
/// has ended, the student pressed Esc, or it has gone on long enough.
fn look_again<R: Runtime>(app: &AppHandle<R>, generation: u64) {
    let more = {
        let s = state();
        if !s.on || s.generation != generation {
            return;
        }
        within_limits(s.steps, s.started.map_or(Duration::ZERO, |at| at.elapsed()))
    };
    if !more {
        return stop(
            app,
            Some("That's as far as I go in one go. Ask me to carry on if there's more."),
        );
    }
    std::thread::sleep(SETTLE);
    if !current(generation) {
        return;
    }
    if let Some(why) = interrupted() {
        return stop(app, Some(why));
    }
    if !coach::capture_for_hand(app) {
        stop(
            app,
            Some("I couldn't look at the screen again, so I've stopped."),
        );
    }
}

/// A capture for a look was refused (a blocked app in front, a password field) or dropped.
pub fn capture_refused<R: Runtime>(app: &AppHandle<R>, message: Option<&str>) {
    let notice = message.map(|why| format!("I've stopped: {why}"));
    stop(app, notice.as_deref());
}

fn act_in_background<R: Runtime>(app: &AppHandle<R>, generation: u64, captured: Captured) {
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("mew-screen-hand".into())
        .spawn(move || act(&handle, generation, captured));
    if spawned.is_err() {
        stop(app, Some("I couldn't do that just now."));
    }
}

/// One look: ask for the next action, do it, and look again.
fn act<R: Runtime>(app: &AppHandle<R>, generation: u64, captured: Captured) {
    let Captured { jpeg, meta, detail } = captured;
    let body = {
        let s = state();
        if !s.on || s.generation != generation {
            return;
        }
        let memory = Memory {
            history: &s.history,
            plan: &s.plan,
            notes: &s.notes,
        };
        act_body(&s.goal, s.mode, &meta, memory, jpeg.as_slice())
    };
    look(app, "thinking");
    drop(jpeg); // only the request body holds the image now
                // A long task is many calls, and one of them will find the model busy or the network
                // slow: that's a pause, not the end. The same look is asked again a few times first.
    let mut tries = 0;
    let reply = loop {
        let reply = device_call::post(app, "api/screen/act", "act", body.as_slice())
            .map(|bytes| parse_act_reply(&bytes));
        if !current(generation) {
            return;
        }
        tries += 1;
        if tries > RETRIES || !worth_retrying(&reply) {
            break reply;
        }
        eprintln!("[screen] hand: no answer, asking again ({tries} of {RETRIES})");
        if !pause(app, generation, RETRY_WAIT) {
            return;
        }
    };
    drop(body);
    look(app, "moving");
    let reply = match reply {
        Ok(Some(reply)) => reply,
        Ok(None) => return stop(app, Some("I couldn't work out the next step. Try again.")),
        Err(CallError::Account(message)) | Err(CallError::Limited(message)) => {
            return stop(app, Some(&message))
        }
        Err(CallError::Busy) => {
            return stop(
                app,
                Some("The model's been busy for a while, so I've stopped. Ask me to carry on in a minute."),
            )
        }
        Err(CallError::Failed) => {
            return stop(
                app,
                Some("I couldn't reach Neb. Check your connection and try again."),
            )
        }
    };
    if let Some(why) = interrupted() {
        return stop(app, Some(why));
    }
    {
        // Its memory for the next look: the plan as it is now, and anything it chose to keep.
        let mut s = state();
        if !s.on || s.generation != generation {
            return;
        }
        if let Some(plan) = reply.plan {
            s.plan = plan;
        }
        if let Some(note) = reply.note.filter(|note| !note.trim().is_empty()) {
            if s.notes.len() < NOTES {
                s.notes.push(note);
            }
        }
    }
    page::dispatch(app, page::SAY, json!({ "text": reply.speech }));
    // What kind of action, never what it pressed, typed or noted.
    let (step, kept) = {
        // One lock, let go before anything else: two in one statement would wait on itself.
        let s = state();
        (s.steps + 1, s.notes.len())
    };
    eprintln!(
        "[screen] hand: step {step}, {}, {kept} notes kept",
        action_kind(&reply.action)
    );

    let did = match reply.action {
        Action::Done | Action::Stop => return stop(app, None), // it said why
        Action::Write { request } => {
            // One more look, of the document as it is now, for the typing to write into.
            state().write = Some(request);
            std::thread::sleep(SETTLE);
            if !current(generation) {
                return;
            }
            if !coach::capture_for_hand(app) {
                stop(
                    app,
                    Some("I couldn't look at the document, so I've stopped."),
                );
            }
            return;
        }
        Action::Point { point, .. } => {
            // "Here it is": the cursor goes there and rests on it, pressing nothing.
            let target = to_screen(point, meta.bounds);
            if glide(app, generation, target) {
                rest(app, generation);
            }
            return;
        }
        Action::Open { what, target } => {
            let opened = match what {
                OpenWhat::Site => launch::open_url(&target)
                    .then(|| format!("Opened {} in the browser.", clip(&target, 100))),
                OpenWhat::App => {
                    let apps = launch::start_apps();
                    launch::pick_app(&target, &apps)
                        .filter(|found| launch::open_app(found))
                        .map(|found| format!("Opened {}.", clip(&found.name, 60)))
                }
            };
            eprintln!(
                "[screen] hand: open {}: {}",
                if what == OpenWhat::Site {
                    "site"
                } else {
                    "app"
                },
                if opened.is_some() {
                    "opened"
                } else {
                    "nothing opened"
                }
            );
            match opened {
                Some(did) => {
                    std::thread::sleep(OPENING.saturating_sub(SETTLE));
                    did
                }
                // Not the end of the run: the model hears it and finds another way.
                None => format!(
                    "Couldn't open “{}”: no installed app has that name, or it's one I leave to you.",
                    clip(&target, 60)
                ),
            }
        }
        Action::Wait => {
            std::thread::sleep(WAIT.saturating_sub(SETTLE));
            "Waited for the screen.".to_owned()
        }
        Action::Click {
            point,
            label,
            button,
            double,
        } => {
            if risky_label(&label) {
                // The server points at these instead; one that slipped through is pointed at
                // here, and never pressed.
                page::dispatch(
                    app,
                    page::SAY,
                    json!({ "text": format!("That one's yours to press: {label}.") }),
                );
                let target = to_screen(point, meta.bounds);
                if glide(app, generation, target) {
                    rest(app, generation);
                }
                return;
            }
            // The model's point; centred on the control's own words only when it's already on
            // them (a caption under a picture names the picture, and isn't the thing to press).
            let at = to_screen(point, meta.bounds);
            let scale = meta.dpi.max(96) as f32 / 96.0;
            let words = detail.text.spot_for_label(&label, at, 48.0 * scale);
            let target = aim(at, words, (8.0 * scale) as i32);
            if !glide(app, generation, target) {
                return;
            }
            // A tap leaves the student's mouse where it is; what a tap can't do borrows it.
            // The island may be over the spot (it isn't in the picture the model saw).
            let _through = PressThrough::start(app);
            let tapped = button == Button::Left && mouse::tap_at(target.0, target.1, double);
            // Where it pressed, never what: for working out a click that lands off its mark.
            eprintln!(
                "[screen] hand: pressed at ({}, {}), model's point ({}, {}), {}",
                target.0,
                target.1,
                at.0,
                at.1,
                if tapped { "tap" } else { "mouse" }
            );
            if !tapped && !mouse::click_and_return(target.0, target.1, button, double) {
                return stop(app, Some(REFUSED));
            }
            look(app, "click");
            describe_click(&label, button, double)
        }
        Action::Scroll {
            point,
            direction,
            amount,
        } => {
            let target = to_screen(point, meta.bounds);
            if !glide(app, generation, target) {
                return;
            }
            let notches = amount.clamp(1, SCROLL_NOTCHES);
            let turn = match direction {
                Direction::Up => notches,
                Direction::Down => -notches,
            };
            let _through = PressThrough::start(app);
            if !mouse::scroll_and_return(target.0, target.1, turn) {
                return stop(app, Some(REFUSED));
            }
            format!(
                "Scrolled {} {notches}.",
                if turn > 0 { "up" } else { "down" }
            )
        }
        Action::Type { text } => {
            if let Some(reason) = refused_app(app_in_front().as_deref()) {
                eprintln!("[screen] hand: didn't type (the app in front)");
                return stop(app, Some(reason));
            }
            let focus = super::screen_write::focus_now(app);
            if focus != Focus::Ordinary {
                eprintln!("[screen] hand: didn't type (focus {focus:?})");
                return stop(
                    app,
                    Some("I didn't type it: the cursor is in a password field or somewhere I can't check."),
                );
            }
            let typed = Typist::start(foreground()).map(|mut typist| typist.type_text(&text));
            match typed {
                Ok(Typed::All) => format!("Typed “{}”.", clip(&text, 60)),
                Ok(Typed::Cancelled) => return stop(app, Some("Stopped.")),
                other => {
                    eprintln!("[screen] hand: couldn't type ({other:?})");
                    return stop(app, Some("I couldn't type that there."));
                }
            }
        }
        Action::Key { key } => {
            if let Some(reason) = refused_app(app_in_front().as_deref()) {
                return stop(app, Some(reason));
            }
            if !mouse::press(key) {
                return stop(app, Some(REFUSED));
            }
            // Neb's own Esc isn't the student stopping it.
            let _ = escape_pressed();
            format!("Pressed {}.", key.name())
        }
    };

    {
        let mut s = state();
        if !s.on || s.generation != generation {
            return;
        }
        s.history.push(clip(&did, HISTORY_CHARS));
        if s.history.len() > HISTORY_ITEMS {
            s.history.remove(0);
        }
        s.steps += 1;
    }
    look_again(app, generation);
}

const REFUSED: &str =
    "Windows didn't let me do that there (the app may be running as administrator).";

/// The app in front now (its executable's name), when Windows says.
fn app_in_front() -> Option<String> {
    use super::win::target::{exe_name_of, foreground_app_window};
    foreground_app_window().and_then(exe_name_of)
}

/// This run is still the one going.
fn current(generation: u64) -> bool {
    let s = state();
    s.on && s.generation == generation
}

/// Why Neb's hand should stop now, if the student pressed Esc.
fn interrupted() -> Option<&'static str> {
    escape_pressed().then_some("Stopped.")
}

/// While this lives, Neb's island lets presses through to the app under it
/// (`screen_island::let_presses_through`); it takes clicks again when this is dropped, however
/// the press went.
struct PressThrough<R: Runtime>(AppHandle<R>);

impl<R: Runtime> PressThrough<R> {
    fn start(app: &AppHandle<R>) -> Self {
        screen_island::let_presses_through(app, true);
        // Long enough for Windows to see the change before the press lands.
        std::thread::sleep(Duration::from_millis(30));
        Self(app.clone())
    }
}

impl<R: Runtime> Drop for PressThrough<R> {
    fn drop(&mut self) {
        screen_island::let_presses_through(&self.0, false);
    }
}

/// Waits `how_long` with the cursor thinking. False if the run ended or the student pressed Esc
/// meanwhile (the hand has stopped).
fn pause<R: Runtime>(app: &AppHandle<R>, generation: u64, how_long: Duration) -> bool {
    let steps = how_long.as_millis() / REST_STEP.as_millis().max(1);
    for _ in 0..steps {
        if !current(generation) {
            return false;
        }
        if let Some(why) = interrupted() {
            stop(app, Some(why));
            return false;
        }
        std::thread::sleep(REST_STEP);
    }
    current(generation)
}

/// Neb's cursor rests on what it was asked to show, then goes. Esc, or anything that ends the
/// run, sends it away sooner.
fn rest<R: Runtime>(app: &AppHandle<R>, generation: u64) {
    look(app, "here");
    let steps = REST.as_millis() / REST_STEP.as_millis().max(1);
    for _ in 0..steps {
        if !current(generation) {
            return;
        }
        if escape_pressed() {
            break;
        }
        std::thread::sleep(REST_STEP);
    }
    stop(app, None);
}

fn look<R: Runtime>(app: &AppHandle<R>, look: &str) {
    overlay::dispatch(app, Surface::Hand, HAND_LOOK, &json!({ "look": look }));
}

/// The scale of the monitor a point is on (1.0 at 100 %).
fn scale_at(at: (i32, i32)) -> f64 {
    super::win::target::monitor_at(at.0, at.1).map_or(1.0, |(_, dpi)| f64::from(dpi.max(96)) / 96.0)
}

fn show_hand<R: Runtime>(app: &AppHandle<R>, at: (i32, i32)) {
    let Some(window) = overlay::ensure(app, Surface::Hand) else {
        return;
    };
    overlay::place(&window, hand_rect(at, scale_at(at)));
    overlay::show_quietly(&window);
    look(app, "moving");
}

/// Glides Neb's cursor to `to`. False if the run ended or the student took over on the way.
fn glide<R: Runtime>(app: &AppHandle<R>, generation: u64, to: (i32, i32)) -> bool {
    let from = state().at;
    let window = overlay::ensure(app, Surface::Hand);
    let scale = scale_at(to);
    for frame in 1..=GLIDE_FRAMES {
        if !current(generation) {
            return false;
        }
        if let Some(why) = interrupted() {
            stop(app, Some(why));
            return false;
        }
        let at = glide_point(from, to, frame, GLIDE_FRAMES);
        if let Some(window) = &window {
            overlay::move_quickly(window, hand_rect(at, scale));
        }
        std::thread::sleep(GLIDE_FRAME);
    }
    state().at = to;
    true
}

// ─── Pure ────────────────────────────────────────────────────────────────────────────────────

/// Neb's hand never acts in these: terminals and shells, and system windows that change how the
/// computer works. Lowercase executable names.
const NEVER_ACT_IN: &[&str] = &[
    "cmd.exe",
    "powershell.exe",
    "powershell_ise.exe",
    "pwsh.exe",
    "windowsterminal.exe",
    "wt.exe",
    "openconsole.exe",
    "conhost.exe",
    "wsl.exe",
    "wslhost.exe",
    "bash.exe",
    "mintty.exe",
    "putty.exe",
    "kitty.exe",
    "alacritty.exe",
    "wezterm-gui.exe",
    "hyper.exe",
    "tabby.exe",
    "regedit.exe",
    "mmc.exe",
    "taskmgr.exe",
    "systemsettings.exe",
    "control.exe",
    "msiexec.exe",
];

/// Whether asking for the same look again could help: the model was busy, the network or the
/// server failed, or the answer couldn't be read. Not when the account or a limit said no,
/// unless that limit is only the model being busy for a moment.
pub fn worth_retrying(reply: &Result<Option<ActReply>, CallError>) -> bool {
    match reply {
        Ok(Some(_)) | Err(CallError::Account(_)) => false,
        Ok(None) | Err(CallError::Busy) | Err(CallError::Failed) => true,
        Err(CallError::Limited(message)) => message.to_lowercase().contains("busy"),
    }
}

/// Whether a run that has taken `steps` actions over `elapsed` may take another.
pub fn within_limits(steps: u32, elapsed: Duration) -> bool {
    steps < MAX_STEPS && elapsed < MAX_TIME
}

/// Why Neb's hand won't act in `app`, if it won't.
pub fn refused_app(app: Option<&str>) -> Option<&'static str> {
    match app {
        None => Some("I can't tell which app that is, so I'll leave it to you."),
        Some(app) if NEVER_ACT_IN.contains(&app) => {
            Some("I don't click or type in terminals or system windows. That one's yours.")
        }
        Some(_) => None,
    }
}

/// Words in a control's name that make it the student's to press: it spends money, sends or
/// publishes, deletes, signs in or out, installs, or agrees to something (the same list as
/// `RISKY_LABEL` in packages/shared/src/screen-act.ts).
const RISKY_WORDS: &[&str] = &[
    "buy",
    "purchase",
    "pay",
    "payment",
    "checkout",
    "check out",
    "order",
    "subscribe",
    "donate",
    "transfer",
    "withdraw",
    "send",
    "post",
    "publish",
    "tweet",
    "share",
    "submit",
    "delete",
    "remove",
    "erase",
    "format",
    "uninstall",
    "install",
    "sign in",
    "sign up",
    "sign out",
    "log in",
    "log out",
    "login",
    "logout",
    "password",
    "accept",
    "agree",
    "allow",
    "authorize",
    "authorise",
    "confirm",
    "unsubscribe",
    "reset",
];

/// Whether a control's name says it's one Neb leaves to the student (whole words, any case).
pub fn risky_label(label: &str) -> bool {
    let words: Vec<String> = label
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect();
    let line = format!(" {} ", words.join(" "));
    RISKY_WORDS
        .iter()
        .any(|risky| line.contains(&format!(" {risky} ")))
}

/// Where to press: the model's point, or the middle of the control's own words (`words`, where
/// OCR read its name) when the point is already on them or within `slack` pixels. Words further
/// off are something else with the same name, such as a caption under the picture to press.
pub fn aim(point: (i32, i32), words: Option<ScreenRect>, slack: i32) -> (i32, i32) {
    match words {
        Some(spot)
            if (spot.left - slack..=spot.right + slack).contains(&point.0)
                && (spot.top - slack..=spot.bottom + slack).contains(&point.1) =>
        {
            ((spot.left + spot.right) / 2, (spot.top + spot.bottom) / 2)
        }
        _ => point,
    }
}

/// A point of the picture (0–1000 across and down it) on the screen.
pub fn to_screen(point: Point, bounds: ScreenRect) -> (i32, i32) {
    let along = |v: u16, start: i32, size: i32| {
        let inside = (i64::from(v.min(1000)) * i64::from(size.max(1)) / 1000) as i32;
        start + inside.min(size.max(1) - 1)
    };
    (
        along(point.x, bounds.left, bounds.width()),
        along(point.y, bounds.top, bounds.height()),
    )
}

/// Where Neb's cursor is on frame `frame` of `frames` from `from` to `to`: quick at first, then
/// easing in to the spot, the way a hand moves a mouse.
pub fn glide_point(from: (i32, i32), to: (i32, i32), frame: u32, frames: u32) -> (i32, i32) {
    let t = f64::from(frame.min(frames)) / f64::from(frames.max(1));
    let eased = 1.0 - (1.0 - t).powi(3);
    let along = |a: i32, b: i32| a + (f64::from(b - a) * eased).round() as i32;
    (along(from.0, to.0), along(from.1, to.1))
}

/// The cursor's window with the arrow's tip at `at` (physical pixels).
pub fn hand_rect(at: (i32, i32), scale: f64) -> ScreenRect {
    let size = (HAND_SIZE * scale).round() as i32;
    let tip = (HAND_TIP * scale).round() as i32;
    ScreenRect {
        left: at.0 - tip,
        top: at.1 - tip,
        right: at.0 - tip + size,
        bottom: at.1 - tip + size,
    }
}

/// The kind of action, for the log.
fn action_kind(action: &Action) -> &'static str {
    match action {
        Action::Click { .. } => "click",
        Action::Open { .. } => "open",
        Action::Scroll { .. } => "scroll",
        Action::Type { .. } => "type",
        Action::Key { key } => key.name(),
        Action::Write { .. } => "write",
        Action::Point { .. } => "point",
        Action::Wait => "wait",
        Action::Done => "done",
        Action::Stop => "stop",
    }
}

fn describe_click(label: &str, button: Button, double: bool) -> String {
    let how = match (button, double) {
        (Button::Right, _) => "Right-clicked",
        (Button::Left, true) => "Double-clicked",
        (Button::Left, false) => "Clicked",
    };
    format!("{how} “{label}”.")
}

/// At most `max` characters of `text`.
fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// What Neb's hand remembers between looks, sent with each: what it did, what it plans, and
/// what it kept of what it read.
#[derive(Debug, Clone, Copy)]
pub struct Memory<'a> {
    pub history: &'a [String],
    pub plan: &'a str,
    pub notes: &'a [String],
}

/// The body of `POST /api/screen/act` (packages/shared/src/screen-act.ts).
pub fn act_body(
    goal: &str,
    mode: Mode,
    meta: &FrameMeta,
    memory: Memory<'_>,
    jpeg: &[u8],
) -> SecretBytes {
    #[derive(Serialize)]
    struct Head<'a> {
        goal: &'a str,
        app: Option<&'a str>,
        scope: &'static str,
        mode: Mode,
        history: &'a [String],
        plan: &'a str,
        notes: &'a [String],
    }
    let head = Head {
        goal,
        app: meta.app.as_deref(),
        scope: super::protocol::scope_name(meta.kind),
        mode,
        history: memory.history,
        plan: memory.plan,
        notes: memory.notes,
    };
    with_image(&head, jpeg, meta.width, meta.height)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Up,
    Down,
}

/// What an `open` opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenWhat {
    App,
    Site,
}

/// The one next thing for Neb's cursor to do.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Click {
        point: Point,
        label: String,
        button: Button,
        double: bool,
    },
    Scroll {
        point: Point,
        direction: Direction,
        amount: i32,
    },
    Type {
        text: String,
    },
    Key {
        key: PlainKey,
    },
    /// The place to write is ready: Neb's typing takes over, with what to write.
    Write {
        request: String,
    },
    /// Open one of the student's installed apps by name, or a web address in their browser
    /// (`win::launch`).
    Open {
        what: OpenWhat,
        target: String,
    },
    /// "Here it is": rest the cursor on something without pressing it. The last action.
    Point {
        point: Point,
        label: String,
    },
    /// The screen is still loading: look again in a moment.
    Wait,
    Done,
    Stop,
}

/// What `POST /api/screen/act` answers.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActReply {
    /// What's left to do, for the next look.
    #[serde(default)]
    pub plan: Option<String>,
    /// Something read on this screen to keep for later.
    #[serde(default)]
    pub note: Option<String>,
    pub speech: String,
    pub action: Action,
    pub turn_id: String,
}

/// The reply, checked: speech that can be said, a point inside the picture, a name that can be
/// shown, one short line of text with no control keys. None for anything else.
pub fn parse_act_reply(bytes: &[u8]) -> Option<ActReply> {
    let reply: ActReply = serde_json::from_slice(bytes).ok()?;
    let inside = |point: &Point| point.x <= 1000 && point.y <= 1000;
    let action_ok = match &reply.action {
        Action::Click { point, label, .. } | Action::Point { point, label } => {
            inside(point) && within(label, LABEL_CHARS)
        }
        Action::Scroll { point, amount, .. } => {
            inside(point) && (1..=SCROLL_NOTCHES).contains(amount)
        }
        Action::Type { text } => {
            !text.is_empty()
                && text.chars().count() <= TYPE_CHARS
                && text.chars().all(|c| !c.is_control() || c == '\t')
        }
        Action::Write { request } => within(request, REQUEST_CHARS),
        Action::Open { what, target } => match what {
            OpenWhat::App => within(target, LABEL_CHARS),
            OpenWhat::Site => launch::safe_url(target),
        },
        Action::Key { .. } | Action::Wait | Action::Done | Action::Stop => true,
    };
    let fits = |text: &Option<String>, max: usize| {
        text.as_ref().is_none_or(|text| {
            text.chars().count() <= max
                && text
                    .chars()
                    .all(|c| !c.is_control() || c == '\n' || c == '\t')
        })
    };
    (action_ok
        && fits(&reply.plan, PLAN_CHARS)
        && fits(&reply.note, NOTE_CHARS)
        && within(&reply.speech, SPEECH_CHARS)
        && is_uuid(&reply.turn_id))
    .then_some(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TURN: &str = "33333333-3333-4333-8333-333333333333";

    fn reply(action: serde_json::Value) -> Option<ActReply> {
        let body = json!({ "speech": "Opening the Insert tab.", "action": action, "turnId": TURN });
        parse_act_reply(body.to_string().as_bytes())
    }

    #[test]
    fn reads_each_action() {
        let click = reply(json!({
            "type": "click", "point": { "x": 120, "y": 40 }, "label": "Insert",
            "button": "left", "double": false,
        }))
        .unwrap();
        assert_eq!(
            click.action,
            Action::Click {
                point: Point { x: 120, y: 40 },
                label: "Insert".into(),
                button: Button::Left,
                double: false,
            }
        );
        assert!(reply(json!({
            "type": "scroll", "point": { "x": 500, "y": 500 }, "direction": "down", "amount": 3,
        }))
        .is_some());
        assert_eq!(
            reply(json!({ "type": "type", "text": "quarterly report" }))
                .unwrap()
                .action,
            Action::Type {
                text: "quarterly report".into()
            }
        );
        assert_eq!(
            reply(json!({ "type": "key", "key": "enter" }))
                .unwrap()
                .action,
            Action::Key {
                key: PlainKey::Enter
            }
        );
        assert_eq!(
            reply(json!({ "type": "write", "request": "an essay on cats" }))
                .unwrap()
                .action,
            Action::Write {
                request: "an essay on cats".into()
            }
        );
        assert_eq!(
            reply(json!({ "type": "key", "key": "ctrl+l" }))
                .unwrap()
                .action,
            Action::Key {
                key: PlainKey::CtrlL
            }
        );
        assert_eq!(
            reply(json!({ "type": "point", "point": { "x": 60, "y": 900 }, "label": "Sign Out" }))
                .unwrap()
                .action,
            Action::Point {
                point: Point { x: 60, y: 900 },
                label: "Sign Out".into(),
            }
        );
        assert_eq!(
            reply(json!({ "type": "wait" })).unwrap().action,
            Action::Wait
        );
        assert_eq!(
            reply(json!({ "type": "open", "what": "app", "target": "Google Chrome" }))
                .unwrap()
                .action,
            Action::Open {
                what: OpenWhat::App,
                target: "Google Chrome".into(),
            }
        );
        assert!(reply(json!({
            "type": "open", "what": "site", "target": "https://www.google.com/search?q=cats",
        }))
        .is_some());
        assert_eq!(
            reply(json!({ "type": "done" })).unwrap().action,
            Action::Done
        );
        assert_eq!(
            reply(json!({ "type": "stop" })).unwrap().action,
            Action::Stop
        );
    }

    #[test]
    fn refuses_anything_it_doesnt_know_or_that_doesnt_fit() {
        // A point off the picture, too many notches, a new line to type, a shortcut, a new kind
        // of action.
        for action in [
            json!({ "type": "click", "point": { "x": 1200, "y": 40 }, "label": "Insert", "button": "left", "double": false }),
            json!({ "type": "click", "point": { "x": 10, "y": 40 }, "label": "", "button": "left", "double": false }),
            json!({ "type": "click", "point": { "x": 10, "y": 40 }, "label": "Insert", "button": "middle", "double": false }),
            json!({ "type": "scroll", "point": { "x": 5, "y": 5 }, "direction": "down", "amount": 50 }),
            json!({ "type": "type", "text": "dir\nformat c:" }),
            json!({ "type": "type", "text": "x".repeat(TYPE_CHARS + 1) }),
            json!({ "type": "point", "point": { "x": 10, "y": 1400 }, "label": "Sign Out" }),
            json!({ "type": "point", "point": { "x": 10, "y": 40 }, "label": "" }),
            json!({ "type": "open", "what": "site", "target": "file:///C:/Windows/System32/cmd.exe" }),
            json!({ "type": "open", "what": "site", "target": "http://example.com" }),
            json!({ "type": "open", "what": "file", "target": "C:\\notes.txt" }),
            json!({ "type": "open", "what": "app", "target": "" }),
            json!({ "type": "key", "key": "alt+f4" }),
            json!({ "type": "key", "key": "delete" }),
            json!({ "type": "key", "key": "ctrl+w" }),
            json!({ "type": "run", "command": "calc.exe" }),
        ] {
            assert_eq!(reply(action.clone()), None, "{action}");
        }
        assert_eq!(parse_act_reply(b"not json"), None);
    }

    #[test]
    fn leaves_buttons_that_buy_send_delete_or_sign_in_to_the_student() {
        for label in [
            "Buy now",
            "PAY",
            "Place order",
            "Send",
            "Post",
            "Delete account",
            "Remove",
            "Sign in",
            "Log out",
            "Install",
            "Accept all",
            "Confirm purchase",
            "Reset",
            "Change password",
        ] {
            assert!(risky_label(label), "{label}");
        }
        // Ordinary controls, including ones that only contain a risky word's letters.
        for label in [
            "Insert",
            "Bold",
            "Save as",
            "File",
            "Table",
            "Next slide",
            "Search",
            "Postscript",
            "Sender name",
            "Formatting",
            "Display",
            "Border",
        ] {
            assert!(!risky_label(label), "{label}");
        }
    }

    #[test]
    fn never_acts_in_a_terminal_a_system_window_or_an_unknown_app() {
        assert!(refused_app(Some("windowsterminal.exe")).is_some());
        assert!(refused_app(Some("systemsettings.exe")).is_some());
        assert!(refused_app(None).is_some());
        assert_eq!(refused_app(Some("winword.exe")), None);
        assert_eq!(refused_app(Some("chrome.exe")), None);
    }

    #[test]
    fn keeps_the_plan_and_a_note_from_a_reply_when_they_fit() {
        let with = |plan: serde_json::Value, note: serde_json::Value| {
            let body = json!({
                "plan": plan, "note": note, "speech": "Reading this page.",
                "action": { "type": "wait" }, "turnId": TURN,
            });
            parse_act_reply(body.to_string().as_bytes())
        };
        let kept = with(
            json!("1. Open Word. 2. Write it up. 3. Save."),
            json!("Evaporation: the sun heats water. (USGS, usgs.gov/water-cycle)"),
        )
        .unwrap();
        assert_eq!(
            kept.plan.as_deref(),
            Some("1. Open Word. 2. Write it up. 3. Save.")
        );
        assert!(kept.note.unwrap().contains("usgs.gov"));
        // Neither is needed (the first server sent none).
        let bare = reply(json!({ "type": "wait" })).unwrap();
        assert_eq!((bare.plan, bare.note), (None, None));
        // Too long, or with control keys in it: the whole reply is refused.
        assert_eq!(with(json!("x".repeat(PLAN_CHARS + 1)), json!("")), None);
        assert_eq!(with(json!(""), json!("y".repeat(NOTE_CHARS + 1))), None);
        assert_eq!(with(json!(""), json!("a\u{1b}[2Jb")), None);
    }

    #[test]
    fn asks_again_when_the_model_is_busy_but_not_when_a_limit_says_no() {
        assert!(worth_retrying(&Err(CallError::Busy)));
        assert!(worth_retrying(&Err(CallError::Failed)));
        assert!(worth_retrying(&Ok(None)));
        assert!(worth_retrying(&Err(CallError::Limited(
            "The tutor is busy right now (too many requests to the model). Try again in a minute."
                .into()
        ))));
        assert!(!worth_retrying(&Err(CallError::Limited(
            "You've used today's questions.".into()
        ))));
        assert!(!worth_retrying(&Err(CallError::Account(
            "Signed out.".into()
        ))));
        assert!(!worth_retrying(&Ok(reply(json!({ "type": "done" })))));
    }

    #[test]
    fn a_run_ends_after_enough_actions_or_enough_time() {
        assert!(within_limits(0, Duration::ZERO));
        assert!(within_limits(MAX_STEPS - 1, Duration::from_secs(60)));
        assert!(!within_limits(MAX_STEPS, Duration::from_secs(60)));
        assert!(!within_limits(3, MAX_TIME));
    }

    #[test]
    fn says_whether_it_was_asked_to_do_it_or_to_show_where_it_is() {
        assert_eq!(serde_json::to_value(Mode::Do).unwrap(), json!("do"));
        assert_eq!(serde_json::to_value(Mode::Show).unwrap(), json!("show"));
    }

    #[test]
    fn a_point_of_the_picture_lands_inside_what_was_captured() {
        // A window on a monitor to the left of the main one.
        let bounds = ScreenRect {
            left: -1500,
            top: 100,
            right: -500,
            bottom: 900,
        };
        assert_eq!(to_screen(Point { x: 0, y: 0 }, bounds), (-1500, 100));
        assert_eq!(to_screen(Point { x: 500, y: 500 }, bounds), (-1000, 500));
        assert_eq!(to_screen(Point { x: 1000, y: 1000 }, bounds), (-501, 899));
    }

    #[test]
    fn the_cursor_glides_from_where_it_was_to_the_spot_and_eases_in() {
        let (from, to) = ((100, 100), (900, 500));
        assert_eq!(glide_point(from, to, 0, 20), from);
        assert_eq!(glide_point(from, to, 20, 20), to);
        // More than half the way by the middle frame, and never past the spot.
        let mid = glide_point(from, to, 10, 20);
        assert!(mid.0 > 500 && mid.0 < 900, "{mid:?}");
        let mut last = from.0;
        for frame in 1..=20 {
            let at = glide_point(from, to, frame, 20);
            assert!(at.0 >= last && at.0 <= to.0);
            last = at.0;
        }
        // The arrow's tip is on the point, at any scale.
        let rect = hand_rect((300, 200), 1.5);
        assert_eq!((rect.left, rect.top), (294, 194));
        assert_eq!((rect.width(), rect.height()), (60, 60));
    }

    #[test]
    fn presses_the_thing_itself_not_a_caption_with_its_name() {
        // "Blank document": the model points at the thumbnail, and the caption is 90 px below.
        let caption = ScreenRect {
            left: 60,
            top: 196,
            right: 150,
            bottom: 212,
        };
        assert_eq!(aim((115, 110), Some(caption), 8), (115, 110));
        // A text button: the point is on its words, so it's centred on them.
        let button = ScreenRect {
            left: 300,
            top: 40,
            right: 350,
            bottom: 56,
        };
        assert_eq!(aim((304, 53), Some(button), 8), (325, 48));
        assert_eq!(aim((296, 60), Some(button), 8), (325, 48)); // just off them
        assert_eq!(aim((304, 53), None, 8), (304, 53));
    }
}
