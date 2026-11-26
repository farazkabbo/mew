//! Shared Windows/Mac Hand wire contract and safety validation.
pub use super::hand_input::{Button, PlainKey};
use super::{
    frame::{FrameMeta, ScreenRect},
    protocol::{is_uuid, with_image, within, Point, SPEECH_CHARS},
    secret::SecretBytes,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
pub const MAX_STEPS: u32 = 80;
const MAX_TIME: Duration = Duration::from_secs(15 * 60);
const PLAN_CHARS: usize = 600;
const NOTE_CHARS: usize = 800;
const LABEL_CHARS: usize = 80;
const TYPE_CHARS: usize = 200;
const REQUEST_CHARS: usize = 500;
const SCROLL_NOTCHES: i32 = 10;
const HAND_SIZE: f64 = 40.;
const HAND_TIP: f64 = 4.;
const URL_CHARS: usize = 300;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Carry the request out.
    #[default]
    Do,
    /// Find the thing and point at it, without pressing it.
    Show,
}

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

pub fn safe_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    url.len() <= URL_CHARS
        && url
            .chars()
            .all(|c| c.is_ascii_graphic() && !matches!(c, '"' | '\'' | '`' | '<' | '>' | '\\'))
        && !host.contains('@')
        && host.contains('.')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
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
            OpenWhat::Site => safe_url(target),
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
    use serde_json::json;

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
