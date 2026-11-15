//! Typing into a document ("type a conclusion", "rewrite this sentence", "fix the grammar"):
//! the words and the screen go to the server, which writes the text; Neb says what it's typing
//! and types it into the app in front, at the student's cursor. Text they selected is replaced,
//! the way typing over a selection always does. Nothing is drawn: it's their document that
//! changes, and Ctrl+Z takes it back.
//!
//! It only ever types where the student asked, and stops rather than guess:
//! - never into a terminal or a shell (`refused_app`), where a new line would run a command;
//! - never into a password field (checked again just before typing, with UI Automation);
//! - only into the window that was in front when they asked, and it stops at once if another
//!   window comes in front, or they press Esc (`win::typing`).
//!
//! Pure parts (the body, the reply, which apps it refuses) are at the bottom and tested.

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
use super::protocol::{is_uuid, with_image, SPEECH_CHARS};
use super::secret::SecretBytes;
use super::win::input::foreground;
use super::win::typing::{type_into, Typed};

/// The longest text typed at once (mirrors packages/shared/src/screen-write.ts).
pub const TEXT_CHARS: usize = 2000;
/// How long the focus check may take on the capture worker.
const FOCUS_WAIT: Duration = Duration::from_secs(2);

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
    let spawned = std::thread::Builder::new()
        .name("mew-screen-write".into())
        .spawn(move || {
            write(&handle, &transcript, captured, window);
            coach::settle(&handle);
        });
    if spawned.is_err() {
        coach::notify(app, "Couldn't type that just now.");
    }
}

fn write<R: Runtime>(app: &AppHandle<R>, transcript: &str, captured: Captured, window: isize) {
    let Captured { jpeg, meta, .. } = captured;
    let body = write_body(transcript, &meta, jpeg.as_slice());
    drop(jpeg); // only the request body holds the image now
    let reply = device_call::post(app, "api/screen/write", "write", body.as_slice());
    drop(body);
    let reply = match reply {
        Ok(bytes) => match parse_write_reply(&bytes) {
            Some(reply) => reply,
            None => {
                coach::notify(
                    app,
                    "I couldn't write that just now. Try again in a moment.",
                );
                return;
            }
        },
        Err(CallError::Account(message)) | Err(CallError::Limited(message)) => {
            coach::notify(app, &message);
            return;
        }
        Err(CallError::Busy) => {
            coach::notify(
                app,
                "You've asked me to type a lot just now. Try again in a little while.",
            );
            return;
        }
        Err(CallError::Failed) => {
            coach::notify(
                app,
                "I couldn't reach Neb. Check your connection and try again.",
            );
            return;
        }
    };
    page::dispatch(app, page::SAY, json!({ "text": reply.speech }));
    if reply.text.is_empty() {
        return; // it said why
    }
    if foreground() != window {
        coach::notify(app, "I didn't type it: another window is in front. Click back into your document and ask again.");
        return;
    }
    if focus_now(app) != Focus::Ordinary {
        coach::notify(
            app,
            "I didn't type it: the cursor is in a password field or somewhere I can't check.",
        );
        return;
    }
    match type_into(window, &reply.text) {
        Typed::All => coach::notify(app, "Typed. Press Ctrl+Z to undo it."),
        Typed::WindowChanged => {
            coach::notify(app, "I stopped typing: another window came in front.")
        }
        Typed::Cancelled => coach::notify(app, "Stopped. Press Ctrl+Z to undo what I typed."),
        Typed::KeysHeld => coach::notify(app, "Let go of Ctrl, Alt and Shift, then ask me again."),
        Typed::Refused => coach::notify(
            app,
            "Windows didn't let me type there (the app may be running as administrator).",
        ),
    }
}

/// What has the keyboard focus now, asked on the capture worker (which owns UI Automation).
fn focus_now<R: Runtime>(app: &AppHandle<R>) -> Focus {
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

/// `POST /api/screen/write`: what was said, the app, and the screen.
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

/// What `POST /api/screen/write` answers (packages/shared/src/screen-write.ts).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReply {
    pub speech: String,
    pub kind: WriteKind,
    pub text: String,
    pub turn_id: String,
}

/// The reply, checked: speech that can be said, text with no control keys but new lines and
/// tabs, within the limits. None for anything else.
pub fn parse_write_reply(bytes: &[u8]) -> Option<WriteReply> {
    let reply: WriteReply = serde_json::from_slice(bytes).ok()?;
    let speech_ok = !reply.speech.trim().is_empty()
        && reply.speech.chars().count() <= SPEECH_CHARS
        && !reply.speech.chars().any(char::is_control);
    let text_ok = reply.text.chars().count() <= TEXT_CHARS
        && reply
            .text
            .chars()
            .all(|c| !c.is_control() || c == '\n' || c == '\t');
    (speech_ok && text_ok && is_uuid(&reply.turn_id)).then_some(reply)
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
    fn takes_text_with_new_lines_only() {
        let ok = format!(
            r#"{{"speech":"Here's a shorter one.","kind":"replace","text":"Cells divide.\nThen grow.","turnId":"{TURN}"}}"#
        );
        let reply = parse_write_reply(ok.as_bytes()).unwrap();
        assert_eq!(reply.kind, WriteKind::Replace);
        assert_eq!(reply.text, "Cells divide.\nThen grow.");

        let escape = format!(
            r#"{{"speech":"Typing.","kind":"insert","text":"a\u001b[2J","turnId":"{TURN}"}}"#
        );
        assert_eq!(parse_write_reply(escape.as_bytes()), None);
        let long = format!(
            r#"{{"speech":"Typing.","kind":"insert","text":"{}","turnId":"{TURN}"}}"#,
            "x".repeat(TEXT_CHARS + 1)
        );
        assert_eq!(parse_write_reply(long.as_bytes()), None);
    }

    #[test]
    fn an_empty_text_is_a_polite_no() {
        let no = format!(
            r#"{{"speech":"That's a terminal, so I won't type there.","kind":"insert","text":"","turnId":"{TURN}"}}"#
        );
        assert_eq!(parse_write_reply(no.as_bytes()).unwrap().text, "");
    }
}
