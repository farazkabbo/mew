//! Watch (the island's eye button): while it's on, Neb looks at the monitor every few seconds and
//! speaks up when it sees a slip in the student's working, with ink beside it, as much as the
//! help level allows. It's for solving a question on screen: a worksheet, a maths app, code.
//!
//! - Turned on only by the student, on the island; off again with the same button, by pausing
//!   Screen Coach, or by itself after `MAX_ON`. The coach frame shows the whole time it's on
//!   (`coach::refresh_frame`), so it's plain that Neb can see the screen.
//! - Each look is one capture through the same privacy pipeline as a question (blocked apps,
//!   private windows, password fields, redaction). A look is skipped while the student is busy
//!   with Neb (the mic, Circle & Ask, a walkthrough, a quiz) and when the screen hasn't changed
//!   since the last one (`glance`): an unchanged screen is never sent twice.
//! - Most looks find nothing and say nothing. A slip is said once: the last thing said goes with
//!   the next look, so the same slip isn't pointed out again while it's still there.
//!
//! Pure parts (the reply and the decisions) are at the bottom and tested.

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Runtime};

use super::annotate::{self, ShowInk};
use super::coach;
use super::config::HelpLevel;
use super::device_call::{self, CallError};
use super::page;
use super::pipeline::Captured;
use super::protocol::{actions_are_valid, with_image, ScreenAction, SPEECH_CHARS};
use super::screen_island;

/// How often Neb looks while Watch is on.
const EVERY: Duration = Duration::from_secs(6);
/// The first look comes soon after the button is pressed.
const FIRST_LOOK: Duration = Duration::from_millis(800);
/// Watch turns itself off after this long (the student turns it on again if they're still at it).
const MAX_ON: Duration = Duration::from_secs(45 * 60);
/// Failed looks in a row before Watch gives up (the network, the server).
const MAX_FAILURES: u32 = 3;

#[derive(Default)]
struct WatchState {
    on: bool,
    /// Bumped at every start and stop: a look or a reply from before belongs to an older one.
    generation: u64,
    started: Option<Instant>,
    /// A look is on its way (capturing or asking): the next tick waits.
    busy: bool,
    /// A thumbnail of the last screen looked at (`glance`).
    last_glance: Option<Vec<u8>>,
    /// The last slip said (sent with the next look, so it isn't said again).
    previous: Option<String>,
    /// The last reason a capture was refused (said once, not every few seconds).
    refused: Option<String>,
    failures: u32,
}

static STATE: Mutex<WatchState> = Mutex::new(WatchState {
    on: false,
    generation: 0,
    started: None,
    busy: false,
    last_glance: None,
    previous: None,
    refused: None,
    failures: 0,
});

fn state() -> MutexGuard<'static, WatchState> {
    STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Watch is on.
pub fn watching() -> bool {
    state().on
}

/// The island's eye button.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    if watching() {
        stop(app, Some("Watch is off."));
    } else {
        start(app);
    }
}

fn start<R: Runtime>(app: &AppHandle<R>) {
    if !coach::is_usable(app) {
        coach::notify(
            app,
            "Turn Screen Coach on first: tray → Screen Coach settings.",
        );
        return;
    }
    if !coach::is_connected(app) {
        coach::notify(app, device_call::NOT_CONNECTED);
        return;
    }
    let generation = {
        let mut s = state();
        s.on = true;
        s.generation += 1;
        s.started = Some(Instant::now());
        s.busy = false;
        s.last_glance = None;
        s.previous = None;
        s.refused = None;
        s.failures = 0;
        s.generation
    };
    coach::notify(
        app,
        "Watch is on: I'll look at your screen every few seconds and tell you if I see a slip.",
    );
    screen_island::refresh(app);
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("mew-screen-watch".into())
        .spawn(move || run(&handle, generation));
    if spawned.is_err() {
        stop(app, Some("Couldn't start Watch just now."));
    }
}

/// Turns Watch off (`notice`: said why). Anything still on its way is dropped.
pub fn stop<R: Runtime>(app: &AppHandle<R>, notice: Option<&str>) {
    {
        let mut s = state();
        if !s.on {
            return;
        }
        s.on = false;
        s.generation += 1;
        s.busy = false;
        s.last_glance = None;
        s.previous = None;
    }
    if let Some(notice) = notice {
        coach::notify(app, notice);
    }
    screen_island::refresh(app);
}

/// The ticks: a look every `EVERY` while this Watch is on.
fn run<R: Runtime>(app: &AppHandle<R>, generation: u64) {
    std::thread::sleep(FIRST_LOOK);
    loop {
        let tick = {
            let s = state();
            if !s.on || s.generation != generation {
                return;
            }
            Tick {
                elapsed: s.started.map_or(Duration::ZERO, |t| t.elapsed()),
                busy: s.busy,
                usable: coach::is_usable(app),
                engaged: engaged(app),
            }
        };
        match tick.decide() {
            Decision::Stop(notice) => {
                stop(app, notice);
                return;
            }
            Decision::Skip => {}
            Decision::Look => {
                state().busy = true;
                if !coach::capture_for_watch(app) {
                    state().busy = false;
                }
            }
        }
        std::thread::sleep(EVERY);
    }
}

/// The student is doing something with Neb right now: a look would get in the way.
fn engaged<R: Runtime>(app: &AppHandle<R>) -> bool {
    coach::mic_on(app)
        || super::circle::in_session(app)
        || super::coach_mode::is_coaching(app)
        || super::screen_quiz::takes_words(app)
}

/// A capture for a look ended without a picture (already said why, or paused meanwhile).
pub fn look_dropped() {
    state().busy = false;
}

/// A capture for a look was refused (a blocked app in front, a password field): said once.
pub fn capture_refused<R: Runtime>(app: &AppHandle<R>, message: &str) {
    let say = {
        let mut s = state();
        s.busy = false;
        let new = s.on && s.refused.as_deref() != Some(message);
        if new {
            s.refused = Some(message.to_owned());
        }
        new
    };
    if say {
        coach::notify(app, &format!("Watch can't look right now: {message}"));
    }
}

/// The capture for a look: sent if the screen changed since the last one.
pub fn on_captured<R: Runtime>(app: &AppHandle<R>, captured: Captured) {
    let (generation, previous, changed) = {
        let mut s = state();
        if !s.on {
            return; // wiped unsent
        }
        s.refused = None;
        let now = super::glance::fingerprint(&captured.detail.pixels);
        let changed = s
            .last_glance
            .as_ref()
            .is_none_or(|before| super::glance::changed(before, &now));
        s.last_glance = Some(now);
        if !changed {
            s.busy = false;
        }
        (s.generation, s.previous.clone(), changed)
    };
    if !changed {
        return;
    }
    let help = coach::help_level(app);
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("mew-screen-watch-look".into())
        .spawn(move || look(&handle, generation, help, previous, captured));
    if spawned.is_err() {
        state().busy = false;
    }
}

fn look<R: Runtime>(
    app: &AppHandle<R>,
    generation: u64,
    help: HelpLevel,
    previous: Option<String>,
    captured: Captured,
) {
    let Captured { jpeg, meta, detail } = captured;
    let body = watch_body(&meta, help, previous.as_deref(), jpeg.as_slice());
    drop(jpeg); // only the request body holds the image now
    let reply = device_call::post(app, "api/screen/watch", "watch", body.as_slice());
    drop(body);
    let current = {
        let mut s = state();
        let current = s.on && s.generation == generation;
        if current {
            s.busy = false;
        }
        current
    };
    if !current {
        return; // turned off meanwhile: whatever came back is dropped, with the frame
    }
    let reply = match reply {
        Ok(bytes) => parse_watch_reply(&bytes),
        Err(CallError::Account(message)) | Err(CallError::Limited(message)) => {
            stop(app, Some(&format!("Watch is off. {message}")));
            return;
        }
        Err(CallError::Busy) => None,
        Err(CallError::Failed) => {
            let give_up = {
                let mut s = state();
                s.failures += 1;
                s.failures >= MAX_FAILURES
            };
            if give_up {
                stop(
                    app,
                    Some("Watch is off: I couldn't reach Neb. Turn it on again in a moment."),
                );
            }
            return;
        }
    };
    state().failures = 0;
    let Some(WatchReply::Mistake {
        speech,
        actions,
        turn_id,
    }) = reply
    else {
        return;
    };
    state().previous = Some(speech.clone());
    page::dispatch(app, page::SAY, json!({ "text": speech }));
    annotate::show(
        app,
        ShowInk {
            seed: turn_id,
            actions,
            meta,
            detail,
            video_time_sec: None,
            clip_when_drawn: false,
            coaching: false,
        },
    );
}

// ─── Pure ────────────────────────────────────────────────────────────────────────────────────

/// What a tick knows.
#[derive(Debug, Clone, Copy)]
struct Tick {
    elapsed: Duration,
    busy: bool,
    /// Screen Coach is on and not paused.
    usable: bool,
    /// The student is using Neb (mic, Circle & Ask, a walkthrough, a quiz).
    engaged: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    Look,
    Skip,
    Stop(Option<&'static str>),
}

impl Tick {
    fn decide(self) -> Decision {
        if !self.usable {
            // Paused, or turned off: Watch goes with it (the pause says so itself).
            Decision::Stop(None)
        } else if self.elapsed >= MAX_ON {
            Decision::Stop(Some(
                "Watch turned itself off after 45 minutes. Turn it on again on the island.",
            ))
        } else if self.busy || self.engaged {
            Decision::Skip
        } else {
            Decision::Look
        }
    }
}

/// `POST /api/screen/watch`: the monitor, its app, the help level and the last slip said.
pub fn watch_body(
    meta: &super::frame::FrameMeta,
    help: HelpLevel,
    previous: Option<&str>,
    jpeg: &[u8],
) -> super::secret::SecretBytes {
    #[derive(Serialize)]
    struct Head<'a> {
        app: Option<&'a str>,
        scope: &'static str,
        help: HelpLevel,
        #[serde(skip_serializing_if = "Option::is_none")]
        previous: Option<&'a str>,
    }
    let previous = previous.map(|p| {
        let end = p.char_indices().nth(300).map_or(p.len(), |(i, _)| i);
        &p[..end]
    });
    let head = Head {
        app: meta.app.as_deref(),
        scope: super::protocol::scope_name(meta.kind),
        help,
        previous,
    };
    with_image(&head, jpeg, meta.width, meta.height)
}

/// What `POST /api/screen/watch` answers (packages/shared/src/screen-watch.ts).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WatchReply {
    Fine,
    Nothing,
    #[serde(rename_all = "camelCase")]
    Mistake {
        speech: String,
        actions: Vec<ScreenAction>,
        turn_id: String,
    },
}

/// The reply, checked like every screen answer. None for anything malformed.
pub fn parse_watch_reply(bytes: &[u8]) -> Option<WatchReply> {
    let reply: WatchReply = serde_json::from_slice(bytes).ok()?;
    let ok = match &reply {
        WatchReply::Fine | WatchReply::Nothing => true,
        WatchReply::Mistake {
            speech,
            actions,
            turn_id,
        } => {
            !speech.trim().is_empty()
                && speech.chars().count() <= SPEECH_CHARS
                && !speech.chars().any(char::is_control)
                && actions_are_valid(actions)
                && super::protocol::is_uuid(turn_id)
        }
    };
    ok.then_some(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tick() -> Tick {
        Tick {
            elapsed: Duration::from_secs(60),
            busy: false,
            usable: true,
            engaged: false,
        }
    }

    #[test]
    fn looks_only_when_free_and_stops_with_screen_coach() {
        assert_eq!(tick().decide(), Decision::Look);
        assert_eq!(
            Tick {
                busy: true,
                ..tick()
            }
            .decide(),
            Decision::Skip
        );
        assert_eq!(
            Tick {
                engaged: true,
                ..tick()
            }
            .decide(),
            Decision::Skip
        );
        assert_eq!(
            Tick {
                usable: false,
                ..tick()
            }
            .decide(),
            Decision::Stop(None)
        );
        assert!(matches!(
            Tick {
                elapsed: MAX_ON,
                ..tick()
            }
            .decide(),
            Decision::Stop(Some(_))
        ));
    }

    #[test]
    fn says_nothing_unless_there_is_a_slip() {
        assert_eq!(
            parse_watch_reply(br#"{"status":"fine"}"#),
            Some(WatchReply::Fine)
        );
        assert_eq!(
            parse_watch_reply(br#"{"status":"nothing"}"#),
            Some(WatchReply::Nothing)
        );
        let slip = br#"{"status":"mistake","speech":"Check line two.","actions":[{"type":"underline","box":{"left":1,"top":2,"right":30,"bottom":40}}],"turnId":"33333333-3333-4333-8333-333333333333"}"#;
        assert!(matches!(
            parse_watch_reply(slip),
            Some(WatchReply::Mistake { .. })
        ));
    }

    #[test]
    fn refuses_a_malformed_slip() {
        let empty = br#"{"status":"mistake","speech":" ","actions":[],"turnId":"33333333-3333-4333-8333-333333333333"}"#;
        assert_eq!(parse_watch_reply(empty), None);
        let bad_id = br#"{"status":"mistake","speech":"Look again.","actions":[],"turnId":"x"}"#;
        assert_eq!(parse_watch_reply(bad_id), None);
        assert_eq!(parse_watch_reply(br#"{"status":"panic"}"#), None);
    }
}
