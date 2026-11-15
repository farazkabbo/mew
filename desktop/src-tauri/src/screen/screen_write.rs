//! Typing into a document ("write an essay on cats", "rewrite this sentence", "fix the
//! grammar"): the words and the screen go to the server, which writes the text and streams it
//! back as it's written; Neb says what it's typing and types it into the app in front, at the
//! student's cursor, a key at a time as the text arrives (`win::typing`). Text they selected is
//! replaced, the way typing over a selection always does. Nothing is drawn: it's their document
//! that changes, and Ctrl+Z takes it back.
//!
//! It only ever types where the student asked, and stops rather than guess:
//! - never into a terminal or a shell (`refused_app`), where a new line would run a command;
//! - never into a password field (checked again just before typing, with UI Automation);
//! - only into the window that was in front when they asked, and it stops at once if another
//!   window comes in front, or they press Esc (`win::typing`).
//!
//! Pure parts (the body, the stream's events, which apps it refuses) are at the bottom and
//! tested.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Runtime};

use super::coach;
use super::device_call::{self, CallError};
use super::frame::FrameMeta;
use super::page;
use super::pipeline::Captured;
use super::privacy::Focus;
use super::protocol::{is_uuid, with_image, within, LineSplitter, SPEECH_CHARS};
use super::secret::SecretBytes;
use super::win::input::foreground;
use super::win::typing::{Typed, Typist};

/// The most typed for one request (mirrors packages/shared/src/screen-write.ts).
pub const TEXT_CHARS: usize = 12_000;
/// The most text in one piece of the stream.
pub const PIECE_CHARS: usize = 2000;
/// How long the focus check may take on the capture worker.
const FOCUS_WAIT: Duration = Duration::from_secs(2);
/// How long to wait for the next piece of the stream before giving up.
const STREAM_WAIT: Duration = Duration::from_secs(45);

/// Neb is writing (from the request until the last key is typed, or it's refused): the island
/// says "Thinking…", so the student keeps their document in front rather than clicking away.
static WRITING: AtomicBool = AtomicBool::new(false);

/// Whether Neb is writing something to type.
pub fn writing() -> bool {
    WRITING.load(Ordering::SeqCst)
}

/// "Type …", "rewrite …": the captured screen and what was said.
pub fn start<R: Runtime>(app: &AppHandle<R>, transcript: String, captured: Captured) {
    if let Some(reason) = refused_app(captured.meta.app.as_deref()) {
        coach::notify(app, reason);
        return;
    }
    // The window they were typing in (the island never takes the focus, so it's still in front).
    let window = captured
        .meta
        .window
        .filter(|&w| w != 0)
        .unwrap_or_else(foreground);
    if window == 0 {
        coach::notify(app, "Click into your document first, then ask again.");
        return;
    }
    let handle = app.clone();
    WRITING.store(true, Ordering::SeqCst);
    super::screen_island::refresh(app);
    let spawned = std::thread::Builder::new()
        .name("mew-screen-write".into())
        .spawn(move || {
            write(&handle, &transcript, captured, window);
            WRITING.store(false, Ordering::SeqCst);
            coach::settle(&handle);
        });
    if spawned.is_err() {
        WRITING.store(false, Ordering::SeqCst);
        super::screen_island::refresh(app);
        coach::notify(app, "Couldn't type that just now.");
    }
}

/// What the network thread passes to the typing one.
enum Incoming {
    Event(WriteEvent),
    /// The request is over: how it ended.
    End(Result<(), CallError>),
}

fn write<R: Runtime>(app: &AppHandle<R>, transcript: &str, captured: Captured, window: isize) {
    let Captured { jpeg, meta, .. } = captured;
    let body = write_body(transcript, &meta, jpeg.as_slice());
    drop(jpeg); // only the request body holds the image now

    // The text is read off the network as fast as it comes, and typed at a human's pace here.
    let (sender, receiver) = mpsc::channel();
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("mew-screen-write-stream".into())
        .spawn(move || {
            let mut lines = LineSplitter::default();
            let events = sender.clone();
            let result = device_call::post_stream(
                &handle,
                "api/screen/write",
                "write",
                body.as_slice(),
                |chunk| {
                    for line in lines.push(chunk) {
                        if let Some(event) = parse_write_event(&line) {
                            let _ = events.send(Incoming::Event(event));
                        }
                    }
                },
            );
            drop(body);
            let _ = sender.send(Incoming::End(result));
        });
    if spawned.is_err() {
        coach::notify(app, "Couldn't type that just now.");
        return;
    }

    let mut typist: Option<Typist> = None;
    let mut typed = 0usize;
    loop {
        let event = match receiver.recv_timeout(STREAM_WAIT) {
            Ok(Incoming::Event(event)) => event,
            Ok(Incoming::End(Ok(()))) => {
                // The stream ended without saying it was done.
                coach::notify(app, &stopped_short(typed));
                return;
            }
            Ok(Incoming::End(Err(error))) => {
                coach::notify(app, &call_failed(error));
                return;
            }
            Err(_) => {
                coach::notify(app, &stopped_short(typed));
                return;
            }
        };
        match event {
            WriteEvent::Start { speech, .. } => {
                page::dispatch(app, page::SAY, json!({ "text": speech }));
            }
            WriteEvent::Text { text } => {
                if typed + text.chars().count() > TEXT_CHARS {
                    coach::notify(app, "That's as much as I type at once. Ask me to continue.");
                    return;
                }
                if typist.is_none() {
                    match ready_to_type(app, window) {
                        Ok(ready) => typist = Some(ready),
                        Err(why) => {
                            coach::notify(app, why);
                            return;
                        }
                    }
                }
                let Some(typist) = typist.as_mut() else {
                    return;
                };
                match typist.type_text(&text) {
                    Typed::All => typed += text.chars().count(),
                    stopped => {
                        coach::notify(app, why_stopped(stopped));
                        return;
                    }
                }
            }
            WriteEvent::Done => {
                if typed > 0 {
                    coach::notify(app, "Typed. Press Ctrl+Z to undo it.");
                }
                return; // with nothing typed, it said why
            }
            WriteEvent::Error { message } => {
                coach::notify(app, &message);
                return;
            }
        }
    }
}

/// The checks just before the first key: the same window still in front, and the cursor
/// somewhere ordinary.
fn ready_to_type<R: Runtime>(app: &AppHandle<R>, window: isize) -> Result<Typist, &'static str> {
    if foreground() != window {
        return Err("I didn't type it: another window is in front. Click back into your document and ask again.");
    }
    if focus_now(app) != Focus::Ordinary {
        return Err(
            "I didn't type it: the cursor is in a password field or somewhere I can't check.",
        );
    }
    Typist::start(window).map_err(why_stopped)
}

fn why_stopped(typed: Typed) -> &'static str {
    match typed {
        Typed::All => "Typed. Press Ctrl+Z to undo it.",
        Typed::WindowChanged => "I stopped typing: another window came in front.",
        Typed::Cancelled => "Stopped. Press Ctrl+Z to undo what I typed.",
        Typed::KeysHeld => "Let go of Ctrl, Alt and Shift, then ask me again.",
        Typed::Refused => {
            "Windows didn't let me type there (the app may be running as administrator)."
        }
    }
}

fn stopped_short(typed: usize) -> String {
    if typed > 0 {
        "I lost the connection part way, so I stopped there. Ask me to continue.".to_owned()
    } else {
        "I couldn't write that just now. Try again in a moment.".to_owned()
    }
}

fn call_failed(error: CallError) -> String {
    match error {
        CallError::Account(message) | CallError::Limited(message) => message,
        CallError::Busy => {
            "You've asked me to type a lot just now. Try again in a little while.".to_owned()
        }
        CallError::Failed => {
            "I couldn't reach Neb. Check your connection and try again.".to_owned()
        }
    }
}

/// What has the keyboard focus now, asked on the capture worker (which owns UI Automation).
pub(super) fn focus_now<R: Runtime>(app: &AppHandle<R>) -> Focus {
    let (sender, receiver) = mpsc::channel();
    let queued = coach::on_worker(app, move |tools| {
        let _ = sender.send(tools.focus());
    });
    if !queued {
        return Focus::Unknown;
    }
    receiver.recv_timeout(FOCUS_WAIT).unwrap_or(Focus::Unknown)
}

// ─── Pure ────────────────────────────────────────────────────────────────────────────────────

/// Apps Neb never types into: terminals and shells (a new line runs a command), and the Run
/// dialog's host. Lowercase executable names.
const NEVER_TYPE_INTO: &[&str] = &[
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
    "explorer.exe",
    "regedit.exe",
    "mmc.exe",
    "taskmgr.exe",
];

/// Why Neb won't type into `app`, if it won't.
pub fn refused_app(app: Option<&str>) -> Option<&'static str> {
    match app {
        None => Some("I can't tell which app that is, so I won't type into it."),
        Some(app) if NEVER_TYPE_INTO.contains(&app) => {
            Some("I don't type into terminals or system windows. Open your document and ask again.")
        }
        Some(_) => None,
    }
}

/// The body of `POST /api/screen/write` (packages/shared/src/screen-write.ts).
pub fn write_body(transcript: &str, meta: &FrameMeta, jpeg: &[u8]) -> SecretBytes {
    #[derive(Serialize)]
    struct Head<'a> {
        transcript: &'a str,
        app: Option<&'a str>,
        scope: &'static str,
    }
    let head = Head {
        transcript,
        app: meta.app.as_deref(),
        scope: super::protocol::scope_name(meta.kind),
    };
    with_image(&head, jpeg, meta.width, meta.height)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteKind {
    Insert,
    Replace,
}

/// One line of what `POST /api/screen/write` streams (packages/shared/src/screen-write.ts).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WriteEvent {
    /// What to say, before any typing.
    Start {
        speech: String,
        kind: WriteKind,
        #[serde(rename = "turnId")]
        turn_id: String,
    },
    /// The next piece of the text, in order.
    Text {
        text: String,
    },
    Done,
    /// It went wrong (in the server's words): nothing more is typed.
    Error {
        message: String,
    },
}

/// One event, checked: speech and messages that can be said, text with no control keys but new
/// lines and tabs, within the limits. None for anything else (the line is ignored).
pub fn parse_write_event(line: &str) -> Option<WriteEvent> {
    let event: WriteEvent = serde_json::from_str(line).ok()?;
    let ok = match &event {
        WriteEvent::Start {
            speech, turn_id, ..
        } => within(speech, SPEECH_CHARS) && is_uuid(turn_id),
        WriteEvent::Text { text } => {
            !text.is_empty()
                && text.chars().count() <= PIECE_CHARS
                && text
                    .chars()
                    .all(|c| !c.is_control() || c == '\n' || c == '\t')
        }
        WriteEvent::Done => true,
        WriteEvent::Error { message } => within(message, SPEECH_CHARS),
    };
    ok.then_some(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TURN: &str = "33333333-3333-4333-8333-333333333333";

    #[test]
    fn never_types_into_a_terminal_or_an_unknown_app() {
        assert!(refused_app(Some("windowsterminal.exe")).is_some());
        assert!(refused_app(Some("powershell.exe")).is_some());
        assert!(refused_app(None).is_some());
        assert_eq!(refused_app(Some("winword.exe")), None);
        assert_eq!(refused_app(Some("chrome.exe")), None);
    }

    #[test]
    fn reads_the_stream_a_line_at_a_time() {
        let start = serde_json::json!({
            "type": "start", "speech": "Here's an essay on cats.", "kind": "insert", "turnId": TURN,
        })
        .to_string();
        assert_eq!(
            parse_write_event(&start),
            Some(WriteEvent::Start {
                speech: "Here's an essay on cats.".into(),
                kind: WriteKind::Insert,
                turn_id: TURN.into(),
            })
        );
        let text = serde_json::json!({ "type": "text", "text": "Cats nap.\n\tThen hunt. " });
        assert_eq!(
            parse_write_event(&text.to_string()),
            Some(WriteEvent::Text {
                text: "Cats nap.\n\tThen hunt. ".into()
            })
        );
        assert_eq!(
            parse_write_event(r#"{"type":"done"}"#),
            Some(WriteEvent::Done)
        );
        assert_eq!(
            parse_write_event(r#"{"type":"error","message":"I can't type that one."}"#),
            Some(WriteEvent::Error {
                message: "I can't type that one.".into()
            })
        );
    }

    #[test]
    fn takes_text_with_new_lines_only_and_nothing_it_doesnt_know() {
        let piece = |text: &str| {
            parse_write_event(&serde_json::json!({ "type": "text", "text": text }).to_string())
        };
        // An escape sequence, an empty piece, and one over the limit.
        assert_eq!(piece("a\u{1b}[2J"), None);
        assert_eq!(piece(""), None);
        assert_eq!(piece(&"x".repeat(PIECE_CHARS + 1)), None);
        assert!(piece(&"x".repeat(PIECE_CHARS)).is_some());
        // A start without a real id, an unknown kind, an unknown event, and not JSON.
        let bad_id = serde_json::json!({
            "type": "start", "speech": "Typing.", "kind": "insert", "turnId": "nope",
        });
        assert_eq!(parse_write_event(&bad_id.to_string()), None);
        let bad_kind = serde_json::json!({
            "type": "start", "speech": "Typing.", "kind": "paste", "turnId": TURN,
        });
        assert_eq!(parse_write_event(&bad_kind.to_string()), None);
        assert_eq!(parse_write_event(r#"{"type":"click","x":1,"y":2}"#), None);
        assert_eq!(parse_write_event(r#"{"error":"Too many requests"}"#), None);
        assert_eq!(parse_write_event("not json"), None);
    }
}
