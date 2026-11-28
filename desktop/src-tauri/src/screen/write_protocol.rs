//! Shared native writing wire protocol.
use super::{
    frame::FrameMeta,
    protocol::{is_uuid, with_image, within, SPEECH_CHARS},
    secret::SecretBytes,
};
use serde::{Deserialize, Serialize};
pub const TEXT_CHARS: usize = 12_000;
pub const PIECE_CHARS: usize = 2000;
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
/// `material`: the notes Neb's hand kept for the piece, when it asked for the writing.
pub fn write_body(
    transcript: &str,
    material: Option<&str>,
    meta: &FrameMeta,
    jpeg: &[u8],
) -> SecretBytes {
    #[derive(Serialize)]
    struct Head<'a> {
        transcript: &'a str,
        app: Option<&'a str>,
        scope: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        material: Option<&'a str>,
    }
    let head = Head {
        transcript,
        app: meta.app.as_deref(),
        scope: super::protocol::scope_name(meta.kind),
        material: material.filter(|notes| !notes.trim().is_empty()),
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
