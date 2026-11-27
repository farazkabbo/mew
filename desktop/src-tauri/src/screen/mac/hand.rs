//! Bounded native Hand and document writing. Model output is a proposal, validated by the
//! shared protocol and independently authorized at every native input event.
use super::{
    actions::{self, BoundTarget},
    capture_session::{self, NativeFrame},
    overlay::{self, Surface},
    pipeline, runtime, service_call, target,
};
use crate::screen::{
    hand_protocol::{self as hand, Action, Memory, Mode},
    intent::{self, Intent},
    page, protocol,
    sign_in::SignIn,
    write_protocol::{self as write, WriteEvent},
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
#[path = "hand_policy.rs"]
pub(crate) mod policy;

#[derive(Default)]
struct State {
    running: bool,
    epoch: u64,
    account: Option<[u8; 32]>,
}
#[derive(Default)]
struct Hand(Mutex<State>);
#[derive(Clone, Copy)]
struct Ticket {
    epoch: u64,
    generation: u64,
    account: [u8; 32],
}
pub fn setup(app: &AppHandle) -> Result<(), String> {
    if !app.manage(Hand::default()) {
        return Err("Native Hand already initialized.".into());
    }
    Ok(())
}
fn account(app: &AppHandle) -> Option<[u8; 32]> {
    service_call::credential_stamp(app).ok()
}
pub fn engaged(app: &AppHandle) -> bool {
    app.try_state::<Hand>()
        .is_some_and(|h| h.0.lock().unwrap_or_else(|p| p.into_inner()).running)
}
pub fn stop_all(app: &AppHandle) {
    if let Some(h) = app.try_state::<Hand>() {
        let mut s = h.0.lock().unwrap_or_else(|p| p.into_inner());
        s.epoch = s.epoch.wrapping_add(1);
        s.account = None;
    }
    if let Some(w) = app.get_webview_window(Surface::Hand.label()) {
        let _ = overlay::hide(&w);
    }
}
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
}
pub(super) fn escaped() -> bool {
    unsafe { CGEventSourceKeyState(1, 53) }
}
fn current(app: &AppHandle, t: Ticket) -> bool {
    if escaped() || account(app) != Some(t.account) {
        return false;
    }
    let Ok(runtime) = runtime::of(app) else {
        return false;
    };
    let (c, reset) = runtime.snapshot();
    if reset
        || !c.is_on()
        || c.paused
        || !c.privacy.let_neb_click
        || !c.privacy.show_in_captures
        || runtime.generation.load(Ordering::Acquire) != t.generation
    {
        return false;
    }
    app.try_state::<Hand>().is_some_and(|h| {
        let s = h.0.lock().unwrap_or_else(|p| p.into_inner());
        s.epoch == t.epoch && s.account == Some(t.account)
    })
}
fn begin(app: &AppHandle) -> Result<Ticket, String> {
    let runtime = runtime::of(app)?;
    let (c, reset) = runtime.snapshot();
    if reset || !c.is_on() || c.paused || !c.privacy.let_neb_click || !c.privacy.show_in_captures {
        return Err(
            "Enable Screen Coach, visible overlays and Let Neb click in local settings first."
                .into(),
        );
    }
    let owner = account(app).ok_or("Connect Screen Coach to your Neb account first.")?;
    let hand = app
        .try_state::<Hand>()
        .ok_or("Native Hand isn't initialized.")?;
    let mut s = hand.0.lock().unwrap_or_else(|p| p.into_inner());
    if s.running {
        return Err("Neb is still working. Press Esc to stop it first.".into());
    }
    s.epoch = s.epoch.wrapping_add(1);
    s.running = true;
    s.account = Some(owner);
    Ok(Ticket {
        epoch: s.epoch,
        generation: runtime.generation.load(Ordering::Acquire),
        account: owner,
    })
}
fn say(app: &AppHandle, text: &str, t: Ticket) {
    let handle = app.clone();
    let text = text.to_owned();
    let _ = app.run_on_main_thread(move || {
        if !current(&handle, t) {
            return;
        }
        if let (Some(window), Some(signin)) = (
            handle.get_webview_window(crate::MAIN),
            handle.try_state::<SignIn>(),
        ) {
            if page::require_app_page(&window, signin.app_url()).is_ok() {
                page::dispatch(&handle, page::SAY, json!({"text":text}));
            }
        }
    });
}
pub fn route_words(app: &AppHandle, text: &str) -> Result<bool, String> {
    route_intent(app, text, intent::intent_of(text, false))
}
pub fn route_intent(app: &AppHandle, text: &str, requested: Intent) -> Result<bool, String> {
    let text = protocol::clean_transcript(text);
    let mode = match requested {
        Intent::Write => None,
        Intent::Act => Some(Mode::Do),
        Intent::Show | Intent::ShowMe => Some(Mode::Show),
        _ => return Ok(false),
    };
    let ticket = begin(app)?;
    let handle = app.clone();
    if std::thread::Builder::new()
        .name("neb-mac-hand".into())
        .spawn(move || {
            let result = if let Some(mode) = mode {
                run(&handle, ticket, &text, mode)
            } else {
                capture_session::capture_window(&handle, pipeline::Intent::Ask, ticket.generation)
                    .and_then(|frame| write_document(&handle, ticket, &text, None, &frame))
            };
            if current(&handle, ticket) {
                if let Err(error) = result {
                    say(&handle, &error, ticket);
                }
            }
            if let Some(h) = handle.try_state::<Hand>() {
                h.0.lock().unwrap_or_else(|p| p.into_inner()).running = false;
            }
            if let Some(w) = handle.get_webview_window(Surface::Hand.label()) {
                let _ = overlay::hide(&w);
            }
        })
        .is_err()
    {
        if let Some(h) = app.try_state::<Hand>() {
            h.0.lock().unwrap_or_else(|p| p.into_inner()).running = false;
        }
        return Err("Couldn't start native Hand.".into());
    }
    Ok(true)
}
fn pause(app: &AppHandle, t: Ticket, duration: Duration) -> Result<(), String> {
    let end = Instant::now() + duration;
    while Instant::now() < end {
        if !current(app, t) {
            return Err("Stopped.".into());
        }
        std::thread::park_timeout(Duration::from_millis(30));
    }
    Ok(())
}
fn bound(frame: &NativeFrame) -> BoundTarget {
    BoundTarget {
        process: frame.target.process.clone(),
        window_id: frame.target.window_id,
        bounds: frame.target.quartz_points,
        generation: frame.generation,
    }
}
fn perform(
    app: &AppHandle,
    t: Ticket,
    target: BoundTarget,
    action: actions::Action,
    label: Option<String>,
) -> Result<(), String> {
    if !current(app, t)
        || !capture_session::is_target_current(
            app,
            &pipeline::Target {
                window_id: target.window_id,
                process: target.process.clone(),
                quartz_points: target.bounds,
            },
            t.generation,
        )
    {
        return Err(
            "The target or privacy settings changed. Stopped before the next input.".into(),
        );
    }
    let browser = super::app_policy::has_inspected_browser_dictionary(&target.process.bundle_id)
        .then(|| policy::BrowserLease::after_verified_target(&target));
    let live = Arc::new(AtomicBool::new(true));
    let active = live.clone();
    let handle = app.clone();
    let deadline = Instant::now() + Duration::from_millis(450);
    let (tx, rx) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        if !active.load(Ordering::Acquire) || Instant::now() >= deadline {
            return;
        }
        let result = actions::perform(&target, &action, |expected, action| {
            if !active.load(Ordering::Acquire) || Instant::now() >= deadline || !current(&handle, t)
            {
                return Err(actions::Error::Cancelled);
            }
            policy::authorize(
                &handle,
                expected,
                action,
                label.as_deref(),
                browser.as_ref(),
            )
        });
        let _ = tx.send(result);
    })
    .map_err(|_| "Couldn't schedule native input.")?;
    let result = rx.recv_timeout(deadline.saturating_duration_since(Instant::now()));
    live.store(false, Ordering::Release);
    match result{Ok(Ok(_))=>Ok(()),_=>Err("Native input stopped because the app, focus or privacy check couldn't be verified. Any partial input stays in your document; use Undo if needed.".into())}
}
fn type_text(app: &AppHandle, t: Ticket, target: &BoundTarget, text: &str) -> Result<(), String> {
    type_text_until(
        app,
        t,
        target,
        text,
        Instant::now() + Duration::from_secs(15 * 60),
    )
}
fn type_text_until(
    app: &AppHandle,
    t: Ticket,
    target: &BoundTarget,
    text: &str,
    deadline: Instant,
) -> Result<(), String> {
    let mut roll = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0x9e37_79b9, |t| t.subsec_nanos())
        | 1;
    for chunk in text_chunks(text) {
        if Instant::now() >= deadline {
            return Err("Typing reached its time limit. Any partial text stays in the document; use Undo if needed.".into());
        }
        let character = chunk.chars().next().ok_or("Empty typing piece.")?;
        perform(app, t, target.clone(), actions::Action::Text(chunk), None)?;
        roll ^= roll << 13;
        roll ^= roll >> 17;
        roll ^= roll << 5;
        pause(app, t, typing_pause(character, roll))?;
    }
    Ok(())
}
/// Same human cadence as win::typing::pause_after; every Unicode scalar receives a fresh
/// native authorization, and an emoji's UTF-16 surrogate pair remains in one event quantum.
fn typing_pause(c: char, roll: u32) -> Duration {
    let key = 8 + roll % 14;
    let breath = match c {
        '\n' => 160 + (roll >> 8) % 120,
        '.' | '!' | '?' => 80 + (roll >> 8) % 90,
        ',' | ';' | ':' => 35 + (roll >> 8) % 40,
        ' ' if (roll >> 4).is_multiple_of(19) => 90 + (roll >> 8) % 110,
        _ => 0,
    };
    Duration::from_millis(u64::from(key + breath))
}
fn text_chunks(text: &str) -> impl Iterator<Item = String> + '_ {
    text.chars().map(|c| c.to_string())
}
fn show_pointer(app: &AppHandle, t: Ticket, point: target::Point, label: &str) {
    let handle = app.clone();
    let label = label.to_owned();
    let _ = app.run_on_main_thread(move || {
        if !current(&handle, t) {
            return;
        }
        if let Ok(window) = overlay::ensure(&handle, Surface::Hand) {
            if let Some(rect) = target::Rect::new(point.x - 4., point.y - 4., 40., 40.) {
                let _ = overlay::place(&window, rect);
            }
            let _ = overlay::dispatch(
                &handle,
                Surface::Hand,
                "mew:hand-look",
                &json!({"look":"here","label":label}),
            );
            let _ = overlay::show_quietly(&window);
        }
    });
}
/// Clamp the start to the verified target: native cursor movement never traverses another
/// application's window. Every emitted point still receives the ordinary Move policy proof.
fn glide_path(
    bounds: target::Rect,
    from: target::Point,
    to: target::Point,
) -> Option<Vec<target::Point>> {
    if !bounds.contains(to) || !from.x.is_finite() || !from.y.is_finite() {
        return None;
    }
    let clamp = |p: target::Point| target::Point {
        x: p.x.clamp(
            bounds.x,
            bounds.x + bounds.width - (bounds.width / 2.).min(0.5),
        ),
        y: p.y.clamp(
            bounds.y,
            bounds.y + bounds.height - (bounds.height / 2.).min(0.5),
        ),
    };
    let from = clamp(from);
    let mut path = (1..=22)
        .map(|step| {
            let (x, y) = hand::glide_point(
                (from.x as i32, from.y as i32),
                (to.x as i32, to.y as i32),
                step,
                22,
            );
            clamp(target::Point {
                x: f64::from(x),
                y: f64::from(y),
            })
        })
        .collect::<Vec<_>>();
    *path.last_mut()? = to;
    Some(path)
}
fn glide(
    app: &AppHandle,
    t: Ticket,
    target: &BoundTarget,
    to: target::Point,
    label: &str,
) -> Result<(), String> {
    let from = super::input::cursor().ok_or("The cursor position is unavailable.")?;
    let path = glide_path(target.bounds, from, to)
        .ok_or("The pointer target is outside the verified document.")?;
    let deadline = Instant::now() + Duration::from_secs(3);
    for point in path {
        if Instant::now() >= deadline || !current(app, t) {
            return Err("The pointer movement was cancelled or timed out.".into());
        }
        perform(app, t, target.clone(), actions::Action::Move(point), None)?;
        show_pointer(app, t, point, label);
        pause(app, t, Duration::from_millis(16))?;
    }
    Ok(())
}
fn point(frame: &NativeFrame, p: protocol::Point) -> target::Point {
    let bounds = frame.target.quartz_points;
    target::Point {
        x: bounds.x + (f64::from(p.x) / 1000. * bounds.width).min(bounds.width - 0.5),
        y: bounds.y + (f64::from(p.y) / 1000. * bounds.height).min(bounds.height - 0.5),
    }
}
fn key(key: hand::PlainKey) -> Result<actions::Action, String> {
    use actions::{PlainKey as K, Shortcut as S};
    use hand::PlainKey as W;
    Ok(match key {
        W::Enter => actions::Action::Key(K::Enter),
        W::Escape => actions::Action::Key(K::Escape),
        W::Tab => actions::Action::Key(K::Tab),
        W::Backspace => actions::Action::Key(K::Backspace),
        W::Up => actions::Action::Key(K::Up),
        W::Down => actions::Action::Key(K::Down),
        W::Left => actions::Action::Key(K::Left),
        W::Right => actions::Action::Key(K::Right),
        W::PageUp => actions::Action::Key(K::PageUp),
        W::PageDown => actions::Action::Key(K::PageDown),
        W::Home => actions::Action::Key(K::Home),
        W::End => actions::Action::Key(K::End),
        W::F5 => actions::Action::Key(K::Refresh),
        W::ShiftTab => actions::Action::Shortcut(S::ShiftTab),
        W::AltLeft => actions::Action::Shortcut(S::Back),
        W::CtrlHome => actions::Action::Shortcut(S::DocumentStart),
        W::CtrlEnd => actions::Action::Shortcut(S::DocumentEnd),
        W::CtrlL => actions::Action::Shortcut(S::AddressBar),
        W::CtrlT => actions::Action::Shortcut(S::NewTab),
        W::CtrlF => actions::Action::Shortcut(S::Find),
        W::CtrlN => actions::Action::Shortcut(S::NewDocument),
        W::CtrlS => actions::Action::Shortcut(S::Save),
        W::Windows => {
            return Err("That Windows-only key has no equivalent in this Mac workflow.".into())
        }
    })
}
fn run(app: &AppHandle, t: Ticket, goal: &str, mode: Mode) -> Result<(), String> {
    let started = Instant::now();
    let mut history = Vec::new();
    let mut plan = String::new();
    let mut notes = Vec::new();
    let mac_goal = protocol::clean_transcript(&format!("On macOS: {goal}"));
    for step in 0..hand::MAX_STEPS {
        if !current(app, t) || !hand::within_limits(step, started.elapsed()) {
            return Err("Stopped at the native Hand limit.".into());
        }
        let frame = capture_session::capture_window(app, pipeline::Intent::Ask, t.generation)?;
        let body = hand::act_body(
            &mac_goal,
            mode,
            &frame.server_meta(),
            Memory {
                history: &history,
                plan: &plan,
                notes: &notes,
            },
            frame.captured.jpeg.as_slice(),
        );
        let cancelled = || !current(app, t) || !capture_session::is_current(app, &frame);
        let mut reply = None;
        for retry in 0..4 {
            match service_call::post_bound(
                app,
                "api/screen/act",
                body.as_slice(),
                &t.account,
                &cancelled,
            ) {
                Ok(bytes) => {
                    reply = hand::parse_act_reply(bytes.as_slice());
                    if reply.is_some() {
                        break;
                    }
                }
                Err(service_call::CallError::Account(e) | service_call::CallError::Limited(e)) => {
                    return Err(e)
                }
                Err(service_call::CallError::Cancelled) => return Err("Stopped.".into()),
                _ => {}
            }
            if retry < 3 {
                pause(app, t, Duration::from_secs(8))?;
            }
        }
        let reply =
            reply.ok_or("I couldn't plan the next step. Stopped without taking an action.")?;
        if cancelled() {
            return Err("The screen changed. Stopped.".into());
        }
        if let Some(next) = reply.plan {
            plan = next;
        }
        if let Some(note) = reply.note {
            notes.push(note);
            if notes.len() > 30 {
                notes.remove(0);
            }
        }
        say(app, &reply.speech, t);
        let target = bound(&frame);
        let description = match reply.action {
            Action::Done | Action::Stop => return Ok(()),
            Action::Wait => {
                pause(app, t, Duration::from_millis(1500))?;
                "Waited for the app.".to_owned()
            }
            Action::Point { point: p, label } => {
                glide(app, t, &target, point(&frame, p), &label)?;
                pause(app, t, Duration::from_secs(8))?;
                return Ok(());
            }
            Action::Click {
                point: p,
                label,
                button,
                double,
            } => {
                let p = point(&frame, p);
                glide(app, t, &target, p, &label)?;
                if hand::risky_label(&label) {
                    return Err("That control needs your own click. I've pointed to it.".into());
                }
                let action = actions::Action::Click {
                    point: p,
                    click_count: 1,
                    button: if button == hand::Button::Left {
                        actions::Button::Primary
                    } else {
                        actions::Button::Secondary
                    },
                };
                perform(app, t, target.clone(), action.clone(), Some(label.clone()))?;
                if double {
                    pause(app, t, Duration::from_millis(45))?;
                    let second = match action {
                        actions::Action::Click { point, button, .. } => actions::Action::Click {
                            point,
                            button,
                            click_count: 2,
                        },
                        _ => unreachable!(),
                    };
                    perform(app, t, target, second, Some(label.clone()))?;
                }
                format!("Clicked {label}.")
            }
            Action::Scroll {
                point: p,
                direction,
                amount,
            } => {
                let p = point(&frame, p);
                glide(app, t, &target, p, "")?;
                perform(
                    app,
                    t,
                    target,
                    actions::Action::Scroll {
                        point: p,
                        vertical: if direction == hand::Direction::Up {
                            amount * 120
                        } else {
                            -amount * 120
                        },
                        horizontal: 0,
                    },
                    None,
                )?;
                "Scrolled.".into()
            }
            Action::Type { text } => {
                type_text(app, t, &target, &text)?;
                "Typed a short line.".into()
            }
            Action::Key { key: k } => {
                perform(app, t, target, key(k)?, None)?;
                format!("Pressed {}.", k.name())
            }
            Action::Write { request } => {
                write_document(app, t, &request, Some(&notes.join("\n")), &frame)?;
                "Wrote the requested text.".into()
            }
            Action::Open {
                what,
                target: requested,
            } => {
                let opened = open(app, t, &frame, what, &requested);
                // Cancellation/target invalidation must stop; a safe unresolved destination
                // is feedback for the next bounded planner step, as on Windows.
                if !current(app, t) || !capture_session::is_current(app, &frame) && opened.is_err()
                {
                    return Err("Stopped before trying another destination.".into());
                }
                open_history(&requested, opened)
            }
        };
        history.push(description);
        if history.len() > 20 {
            history.remove(0);
        }
        pause(app, t, Duration::from_millis(500))?;
    }
    Err("Stopped after 80 actions. Review what changed before continuing.".into())
}
fn open_history(requested: &str, result: Result<(), String>) -> String {
    let requested: String = requested.chars().take(100).collect();
    match result { Ok(()) => format!("Opened {requested}."), Err(_) => format!("Couldn't open {requested}: no matching installed application or safe destination was available. Try another route.") }
}
fn safe_app_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ![
        "terminal",
        "iterm",
        "warp",
        "kitty",
        "alacritty",
        "wezterm",
        "hyper",
        "tabby",
        "system settings",
        "system preferences",
        "installer",
        "uninstall",
        "script editor",
        "automator",
        "shortcuts",
        "activity monitor",
        "console",
        "disk utility",
        "keychain",
        "password",
    ]
    .iter()
    .any(|word| lower.contains(word))
}
fn open(
    app: &AppHandle,
    t: Ticket,
    frame: &NativeFrame,
    what: hand::OpenWhat,
    requested: &str,
) -> Result<(), String> {
    if !current(app, t) || !capture_session::is_current(app, frame) {
        return Err("Stopped before opening the requested destination.".into());
    }
    let result = match what {
        hand::OpenWhat::Site => {
            if !hand::safe_url(requested) {
                return Err("That address isn't safe to open.".into());
            }
            std::process::Command::new("/usr/bin/open")
                .arg("--")
                .arg(requested)
                .status()
        }
        hand::OpenWhat::App => {
            // Resolve an installed app explicitly. Model text is never interpreted as a path,
            // shell expression or command-line option.
            if requested.is_empty()
                || requested.contains(['/', '\\', ':'])
                || requested.starts_with('-')
            {
                return Err("Name an installed application.".into());
            }
            if !safe_app_name(requested) {
                return Err("Terminals, system tools and installers are yours to open.".into());
            }
            let found = [
                "/Applications",
                "/System/Applications",
                "/System/Applications/Utilities",
            ]
            .iter()
            .map(|root| std::path::Path::new(root).join(format!("{requested}.app")))
            .find(|p| p.is_dir())
            .ok_or("That application isn't installed in a standard Applications folder.")?;
            std::process::Command::new("/usr/bin/open")
                .arg("-a")
                .arg(found)
                .status()
        }
    };
    if !result.is_ok_and(|r| r.success()) {
        return Err("The requested destination couldn't be opened.".into());
    }
    pause(app, t, Duration::from_millis(2500))
}

/// Validate every stream event before dispatching that piece. A later failure retains an
/// explicit partial-input result; a malformed piece itself never reaches native input.
#[derive(Default)]
struct Writing {
    started: bool,
    done: bool,
    text: String,
    speech: Option<String>,
    error: Option<String>,
}
impl Drop for Writing {
    fn drop(&mut self) {
        crate::screen::secret::wipe(unsafe { self.text.as_bytes_mut() });
    }
}
impl Writing {
    fn feed(&mut self, line: &str) {
        if self.error.is_some() {
            return;
        }
        match write::parse_write_event(line) {
            Some(WriteEvent::Start { speech, .. }) if !self.started && !self.done => {
                self.started = true;
                self.speech = Some(speech);
            }
            Some(WriteEvent::Text { text }) if self.started && !self.done => {
                if self.text.chars().count() + text.chars().count() > write::TEXT_CHARS {
                    self.error = Some("The writing exceeded its size limit.".into());
                } else {
                    self.text.push_str(&text);
                }
            }
            Some(WriteEvent::Done) if self.started && !self.done => self.done = true,
            Some(WriteEvent::Error { message }) => self.error = Some(message),
            _ => self.error = Some("The writing reply was incomplete or malformed.".into()),
        }
    }
    fn feed_live(
        &mut self,
        line: &str,
        deliver: &mut impl FnMut(Option<&str>, Option<&str>) -> Result<(), String>,
    ) -> Result<(), String> {
        let previous = self.text.len();
        self.feed(line);
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        let speech = self.speech.take();
        let text = (self.text.len() > previous).then(|| &self.text[previous..]);
        if let Err(error) = deliver(speech.as_deref(), text) {
            self.error = Some(error.clone());
            return Err(error);
        }
        Ok(())
    }
    fn validate(&self) -> Result<(), String> {
        if let Some(error) = &self.error {
            Err(error.clone())
        } else if !self.started || !self.done || self.text.is_empty() {
            Err("The writing reply ended before it was complete.".into())
        } else {
            Ok(())
        }
    }
}
enum WriteDelivery {
    Line(String),
    Finished(Result<(), String>),
}
fn write_document(
    app: &AppHandle,
    t: Ticket,
    request: &str,
    material: Option<&str>,
    frame: &NativeFrame,
) -> Result<(), String> {
    let body = write::write_body(
        request,
        material,
        &frame.server_meta(),
        frame.captured.jpeg.as_slice(),
    );
    let stopped = Arc::new(AtomicBool::new(false));
    let network_stop = stopped.clone();
    let handle = app.clone();
    let target = frame.target.clone();
    // Producer validation bounds the entire queue to at most TEXT_CHARS nonempty text
    // events (+Start/Done), regardless of network chunking. Native typing never stalls the
    // HTTP reader or consumes its 90-second network deadline.
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("neb-mac-write-stream".into())
        .spawn(move || {
            let mut lines = protocol::LineSplitter::default();
            let mut checked = Writing::default();
            let mut failure = None;
            let cancelled = || {
                network_stop.load(Ordering::Acquire)
                    || !current(&handle, t)
                    || !capture_session::is_target_current(&handle, &target, t.generation)
            };
            let response = service_call::post_stream_bound(
                &handle,
                "api/screen/write",
                body.as_slice(),
                &t.account,
                &cancelled,
                |chunk| {
                    if network_stop.load(Ordering::Acquire) {
                        return;
                    }
                    for line in lines.push(chunk) {
                        checked.feed(&line);
                        if let Some(error) = &checked.error {
                            failure = Some(error.clone());
                            network_stop.store(true, Ordering::Release);
                            break;
                        }
                        if tx.send(WriteDelivery::Line(line)).is_err() {
                            network_stop.store(true, Ordering::Release);
                            break;
                        }
                    }
                },
            );
            if failure.is_none() && response.is_ok() {
                if let Some(line) = lines.finish() {
                    checked.feed(&line);
                    if let Some(error) = &checked.error {
                        failure = Some(error.clone());
                    } else {
                        let _ = tx.send(WriteDelivery::Line(line));
                    }
                }
            }
            let result = failure.map_or_else(
                || {
                    response
                        .map_err(|e| e.to_string())
                        .and_then(|_| checked.validate())
                },
                Err,
            );
            let _ = tx.send(WriteDelivery::Finished(result));
        })
        .map_err(|_| "Couldn't start the writing stream.".to_owned())?;
    let mut writing = Writing::default();
    let mut typed = 0usize;
    let target = bound(frame);
    let deadline = Instant::now() + Duration::from_secs(15 * 60);
    let mut deliver = |speech: Option<&str>, text: Option<&str>| {
        if !current(app, t) {
            return Err("Stopped.".into());
        }
        if let Some(speech) = speech {
            say(app, speech, t);
        }
        if let Some(text) = text {
            type_text_until(app, t, &target, text, deadline)?;
            typed += text.chars().count();
        }
        Ok(())
    };
    let result = loop {
        if !current(app, t) || Instant::now() >= deadline {
            break Err("Writing was cancelled or reached its time limit.".into());
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(WriteDelivery::Line(line)) => {
                if let Err(error) = writing.feed_live(&line, &mut deliver) {
                    break Err(error);
                }
            }
            Ok(WriteDelivery::Finished(result)) => break result.and_then(|_| writing.validate()),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break Err("The writing stream ended before it was complete.".into())
            }
        }
    };
    stopped.store(true, Ordering::Release);
    result.map_err(|message| partial_write_message(&message, typed))
}

fn partial_write_message(message: &str, typed: usize) -> String {
    if typed == 0 {
        message.to_owned()
    } else {
        format!("{message} Some text was already typed; use Undo to remove it.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn writing_delivers_validated_pieces_before_done_and_reports_later_failure() {
        let mut writing = Writing::default();
        let mut output = Vec::new();
        let mut deliver = |speech: Option<&str>, text: Option<&str>| {
            if let Some(speech) = speech {
                output.push(format!("say:{speech}"));
            }
            if let Some(text) = text {
                output.push(format!("type:{text}"));
            }
            Ok(())
        };
        writing.feed_live(r#"{"type":"start","speech":"Writing now","kind":"insert","turnId":"00000000-0000-4000-8000-000000000001"}"#,&mut deliver).unwrap();
        writing
            .feed_live(r#"{"type":"text","text":"First piece"}"#, &mut deliver)
            .unwrap();
        assert!(!writing.done);
        assert!(writing.validate().is_err());
        writing
            .feed_live(r#"{"type":"text","text":"bad\u0000"}"#, &mut deliver)
            .unwrap_err();
        assert_eq!(output, vec!["say:Writing now", "type:First piece"]);
        assert!(partial_write_message("The stream ended.", 11).contains("Undo"));
        assert_eq!(partial_write_message("Stopped.", 0), "Stopped.");
    }
    #[test]
    fn delivery_failure_stops_all_later_stream_input() {
        let mut writing = Writing::default();
        let mut calls = 0;
        let mut deliver = |_: Option<&str>, _: Option<&str>| {
            calls += 1;
            Err("Target changed".to_owned())
        };
        assert!(writing.feed_live(r#"{"type":"start","speech":"Writing","kind":"insert","turnId":"00000000-0000-4000-8000-000000000001"}"#,&mut deliver).is_err());
        assert!(writing
            .feed_live(r#"{"type":"text","text":"Never typed"}"#, &mut deliver)
            .is_err());
        assert_eq!(calls, 1);
        assert!(writing.text.is_empty());
    }
    #[test]
    fn unresolved_destinations_are_bounded_planner_feedback() {
        assert_eq!(open_history("Pages", Ok(())), "Opened Pages.");
        let failed = open_history(
            &"x".repeat(2000),
            Err("Internal path must not be repeated".into()),
        );
        assert!(failed.contains("Try another route"));
        assert!(!failed.contains("Internal path"));
        assert!(failed.len() < 250);
    }
    #[test]
    fn glide_uses_shared_easing_and_never_leaves_verified_window() {
        let bounds = target::Rect::new(-1440., -200., 1200., 800.).unwrap();
        let to = target::Point { x: -600., y: 300. };
        let points = glide_path(
            bounds,
            target::Point {
                x: 5000.,
                y: -2000.,
            },
            to,
        )
        .unwrap();
        assert_eq!(points.len(), 22);
        assert!(points.iter().all(|p| bounds.contains(*p)));
        assert_eq!(points.last(), Some(&to));
        assert!(glide_path(bounds, to, target::Point { x: 0., y: 0. }).is_none());
        assert!(glide_path(bounds, target::Point { x: f64::NAN, y: 0. }, to).is_none());
    }
    #[test]
    fn single_scalar_typing_keeps_unicode_and_human_punctuation_pauses() {
        let text = "é😀a\n".repeat(3000);
        let pieces = text_chunks(&text).collect::<Vec<_>>();
        assert_eq!(pieces.len(), 12_000);
        assert!(pieces
            .iter()
            .all(|p| p.chars().count() == 1 && p.encode_utf16().count() <= 2));
        assert_eq!(pieces.concat(), text);
        assert!(typing_pause('a', 0).as_millis() >= 8);
        assert!(typing_pause('.', 0) > typing_pause('a', 0));
        assert!(typing_pause('\n', 0) > typing_pause('.', 0));
    }
    #[test]
    fn chunks_preserve_unicode_without_splitting_surrogates() {
        let text = "A😀".repeat(40);
        let chunks = text_chunks(&text).collect::<Vec<_>>();
        assert!(chunks
            .iter()
            .all(|c| c.chars().count() == 1 && c.encode_utf16().count() <= 2));
        assert_eq!(chunks.concat(), text);
    }
    #[test]
    fn rejects_out_of_order_and_truncated_write_streams() {
        let mut w = Writing::default();
        w.feed(r#"{"type":"text","text":"danger"}"#);
        assert!(w.validate().is_err());
        let mut w = Writing::default();
        w.feed(r#"{"type":"start","speech":"Writing","kind":"insert","turnId":"00000000-0000-4000-8000-000000000001"}"#);
        w.feed(r#"{"type":"text","text":"Good text"}"#);
        assert!(w.validate().is_err());
        w.feed(r#"{"type":"done"}"#);
        assert!(w.validate().is_ok());
        w.feed(r#"{"type":"text","text":"late text"}"#);
        assert!(w.validate().is_err());
    }
    #[test]
    fn maps_only_allowlisted_navigation_keys() {
        assert_eq!(
            key(hand::PlainKey::CtrlL).unwrap(),
            actions::Action::Shortcut(actions::Shortcut::AddressBar)
        );
        assert!(key(hand::PlainKey::Windows).is_err());
    }
    #[test]
    fn stream_malicious_controls_never_reach_typing() {
        let mut w = Writing::default();
        w.feed(r#"{"type":"start","speech":"Writing","kind":"insert","turnId":"00000000-0000-4000-8000-000000000001"}"#);
        w.feed(r#"{"type":"text","text":"hello\u0000"}"#);
        w.feed(r#"{"type":"done"}"#);
        assert!(w.validate().is_err());
        assert!(w.text.is_empty());
    }
}
