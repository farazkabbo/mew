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

use serde_json::json;
use tauri::{AppHandle, Runtime};

use super::coach;
use super::device_call::{self, CallError};
use super::page;
use super::pipeline::Captured;
use super::privacy::Focus;
use super::protocol::LineSplitter;
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
    begin(app, transcript, None, captured);
}

/// Neb's hand got a document ready and asks for the writing (`screen_hand.rs`): `request` is
/// what to write and `material` the notes it kept on the way. The hand hears how it went
/// (`screen_hand::after_write`) and carries on from there.
pub fn start_for_hand<R: Runtime>(
    app: &AppHandle<R>,
    request: String,
    material: String,
    captured: Captured,
) {
    begin(app, request, Some(material), captured);
}

fn begin<R: Runtime>(
    app: &AppHandle<R>,
    transcript: String,
    material: Option<String>,
    captured: Captured,
) {
    let for_hand = material.is_some();
    if let Some(reason) = refused_app(captured.meta.app.as_deref()) {
        coach::notify(app, reason);
        if for_hand {
            super::screen_hand::after_write(app, false);
        }
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
        if for_hand {
            super::screen_hand::after_write(app, false);
        }
        return;
    }
    let handle = app.clone();
    WRITING.store(true, Ordering::SeqCst);
    super::screen_island::refresh(app);
    let spawned = std::thread::Builder::new()
        .name("mew-screen-write".into())
        .spawn(move || {
            let all = write(&handle, &transcript, material.as_deref(), captured, window);
            WRITING.store(false, Ordering::SeqCst);
            if for_hand {
                super::screen_hand::after_write(&handle, all);
            } else {
                coach::settle(&handle);
            }
        });
    if spawned.is_err() {
        WRITING.store(false, Ordering::SeqCst);
        super::screen_island::refresh(app);
        coach::notify(app, "Couldn't type that just now.");
        if for_hand {
            super::screen_hand::after_write(app, false);
        }
    }
}

/// What the network thread passes to the typing one.
enum Incoming {
    Event(WriteEvent),
    /// The request is over: how it ended.
    End(Result<(), CallError>),
}

/// Asks for the text and types it as it comes. True when all of it was typed.
fn write<R: Runtime>(
    app: &AppHandle<R>,
    transcript: &str,
    material: Option<&str>,
    captured: Captured,
    window: isize,
) -> bool {
    let Captured { jpeg, meta, .. } = captured;
    let body = write_body(transcript, material, &meta, jpeg.as_slice());
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
        return false;
    }

    let mut typist: Option<Typist> = None;
    let mut typed = 0usize;
    loop {
        let event = match receiver.recv_timeout(STREAM_WAIT) {
            Ok(Incoming::Event(event)) => event,
            Ok(Incoming::End(Ok(()))) => {
                // The stream ended without saying it was done.
                coach::notify(app, &stopped_short(typed));
                return false;
            }
            Ok(Incoming::End(Err(error))) => {
                coach::notify(app, &call_failed(error));
                return false;
            }
            Err(_) => {
                coach::notify(app, &stopped_short(typed));
                return false;
            }
        };
        match event {
            WriteEvent::Start { speech, .. } => {
                page::dispatch(app, page::SAY, json!({ "text": speech }));
            }
            WriteEvent::Text { text } => {
                if typed + text.chars().count() > TEXT_CHARS {
                    coach::notify(app, "That's as much as I type at once. Ask me to continue.");
                    return false;
                }
                if typist.is_none() {
                    match ready_to_type(app, window) {
                        Ok(ready) => typist = Some(ready),
                        Err(why) => {
                            coach::notify(app, why);
                            return false;
                        }
                    }
                }
                let Some(typist) = typist.as_mut() else {
                    return false;
                };
                match typist.type_text(&text) {
                    Typed::All => typed += text.chars().count(),
                    stopped => {
                        coach::notify(app, why_stopped(stopped));
                        return false;
                    }
                }
            }
            WriteEvent::Done => {
                if typed > 0 {
                    coach::notify(app, "Typed. Press Ctrl+Z to undo it.");
                }
                return typed > 0; // with nothing typed, it said why
            }
            WriteEvent::Error { message } => {
                coach::notify(app, &message);
                return false;
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
pub use super::write_protocol::{
    parse_write_event, refused_app, write_body, WriteEvent, WriteKind,
};
