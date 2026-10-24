//! What Screen Coach sends to the web app's server and gets back (mirrors
//! packages/shared/src/screen.ts and devices.ts). Pure: no I/O, fully tested.
//!
//! Everything the server returns is checked here before it reaches a page or the overlay:
//! the server validated it too, but the desktop app treats the network as untrusted.

use serde::{Deserialize, Serialize};

use super::base64;
use super::frame::{FrameMeta, TargetKind};
use super::secret::SecretBytes;

pub const SPEECH_CHARS: usize = 300;
pub const LABEL_CHARS: usize = 40;
pub const NOTE_CHARS: usize = 80;
pub const STEP_CHARS: usize = 120;
pub const MAX_ACTIONS: usize = 8;
pub const TRANSCRIPT_CHARS: usize = 500;
/// The longest video a timestamp may point into (a day).
pub const MAX_VIDEO_SECONDS: u32 = 86_400;

// ─── Asking ──────────────────────────────────────────────────────────────────────────────────

/// Cleans what the student said (it came from a page): no control characters, length capped.
pub fn clean_transcript(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control())
        .take(TRANSCRIPT_CHARS)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// The JSON body of `POST /api/screen/ask`, built straight into a wipeable buffer (it holds the
/// screenshot).
/// `walkthrough`: the walkthrough in progress, if any (coach mode, S4).
pub fn ask_body(
    transcript: &str,
    meta: &FrameMeta,
    video_playing: Option<bool>,
    walkthrough: Option<&str>,
    jpeg: &[u8],
) -> SecretBytes {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Head<'a> {
        transcript: &'a str,
        app: Option<&'a str>,
        scope: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        video_playing: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        walkthrough_id: Option<&'a str>,
    }
    let head = Head {
        transcript,
        app: meta.app.as_deref(),
        scope: scope_name(meta.kind),
        video_playing,
        walkthrough_id: walkthrough,
    };
    with_image(&head, jpeg, meta.width, meta.height)
}

/// The JSON body of `POST /api/screen/reanchor`: the earlier ink and a new screenshot.
pub fn reanchor_body(
    meta: &FrameMeta,
    focus_kind: FocusKind,
    focus_text: &str,
    previous: &[ScreenAction],
    jpeg: &[u8],
) -> SecretBytes {
    #[derive(Serialize)]
    struct Focus<'a> {
        kind: FocusKind,
        text: &'a str,
    }
    #[derive(Serialize)]
    struct Head<'a> {
        app: Option<&'a str>,
        scope: &'static str,
        focus: Focus<'a>,
        previous: &'a [ScreenAction],
    }
    let text: String = focus_text.chars().take(300).collect();
    let head = Head {
        app: meta.app.as_deref(),
        scope: scope_name(meta.kind),
        focus: Focus {
            kind: focus_kind,
            text: &text,
        },
        previous,
    };
    with_image(&head, jpeg, meta.width, meta.height)
}

pub(super) fn scope_name(kind: TargetKind) -> &'static str {
    match kind {
        TargetKind::Window => "window",
        TargetKind::Monitor => "monitor",
    }
}

/// `head` (a JSON object) with `"image": {"jpeg": <base64>, "width", "height"}` added last.
/// Small fields go through serde; the image is base64-encoded in place, into a buffer sized
/// exactly up front (growing would copy the image and free the old copy unwiped).
pub fn with_image(head: &impl Serialize, jpeg: &[u8], width: u32, height: u32) -> SecretBytes {
    // Serialising plain strings, numbers and options can't fail.
    let head = serde_json::to_string(head).unwrap_or_else(|_| "{}".to_owned());
    let open = head.strip_suffix('}').unwrap_or("{");
    let comma = if open.len() > 1 { "," } else { "" };
    let image_key = format!(r#"{comma}"image":{{"jpeg":""#);
    let size = format!(r#"","width":{width},"height":{height}}}}}"#);

    let total = open.len() + image_key.len() + base64::encoded_len(jpeg.len()) + size.len();
    let mut body = Vec::with_capacity(total);
    body.extend_from_slice(open.as_bytes());
    body.extend_from_slice(image_key.as_bytes());
    base64::encode_into(jpeg, &mut body);
    body.extend_from_slice(size.as_bytes());
    debug_assert_eq!(body.len(), total);
    SecretBytes::from_vec(body)
}

// ─── The streamed reply ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: u16,
    pub y: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Box2 {
    pub left: u16,
    pub top: u16,
    pub right: u16,
    pub bottom: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FocusKind {
    Question,
    Figure,
    VideoFrame,
    Code,
    Text,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteSide {
    Left,
    Right,
    Below,
    Auto,
}

/// The tutor's ink (packages/shared/src/screen.ts), in 0–1000 screenshot coordinates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScreenAction {
    FocusRegion {
        #[serde(rename = "box")]
        region: Box2,
        kind: FocusKind,
    },
    CircleRegion {
        #[serde(rename = "box")]
        region: Box2,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        /// Notes Check: a question about this text (amber), not the tutor's usual ink.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tone: Option<InkTone>,
    },
    Underline {
        #[serde(rename = "box")]
        region: Box2,
    },
    Highlight {
        #[serde(rename = "box")]
        region: Box2,
    },
    PointAt {
        point: Point,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    MarginNote {
        text: String,
        #[serde(rename = "besideBox")]
        beside: Box2,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        side: Option<NoteSide>,
    },
    WriteStep {
        #[serde(rename = "latexOrText")]
        text: String,
        #[serde(rename = "besideBox")]
        beside: Box2,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        side: Option<NoteSide>,
    },
    /// Notes Check: a small tick beside text the student's notes already have.
    CheckMark {
        #[serde(rename = "box")]
        region: Box2,
    },
    Clear,
}

/// A colour variant of the tutor's ink.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InkTone {
    /// Amber: "look at this again" (Notes Check differences).
    Question,
}

impl ScreenAction {
    /// The same action with every box and point moved by `f` (re-placed ink).
    pub fn map_coordinates(&self, mut f: impl FnMut(u16, u16) -> (u16, u16)) -> Self {
        let mut map_box = |b: &Box2| {
            let (left, top) = f(b.left, b.top);
            let (right, bottom) = f(b.right, b.bottom);
            Box2 {
                left: left.min(right),
                top: top.min(bottom),
                right: right.max(left),
                bottom: bottom.max(top),
            }
        };
        let mut moved = self.clone();
        match &mut moved {
            ScreenAction::FocusRegion { region, .. }
            | ScreenAction::CircleRegion { region, .. }
            | ScreenAction::Underline { region }
            | ScreenAction::Highlight { region }
            | ScreenAction::CheckMark { region } => *region = map_box(region),
            ScreenAction::MarginNote { beside, .. } | ScreenAction::WriteStep { beside, .. } => {
                *beside = map_box(beside)
            }
            ScreenAction::PointAt { point, .. } => {
                let (x, y) = f(point.x, point.y);
                *point = Point { x, y };
            }
            ScreenAction::Clear => {}
        }
        moved
    }

    /// The texts the overlay would write (labels, notes, steps).
    pub fn texts(&self) -> Vec<&str> {
        match self {
            ScreenAction::CircleRegion { label, .. } | ScreenAction::PointAt { label, .. } => {
                label.iter().map(String::as_str).collect()
            }
            ScreenAction::MarginNote { text, .. } | ScreenAction::WriteStep { text, .. } => {
                vec![text.as_str()]
            }
            _ => Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenMode {
    Answer,
    CoachStep,
    CoachComplete,
    Quiz,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ScreenReply {
    pub speech: String,
    pub actions: Vec<ScreenAction>,
    pub mode: ScreenMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_time_sec: Option<u32>,
}

impl ScreenReply {
    /// The focus region, if the reply draws anything (the server always puts it first).
    pub fn focus(&self) -> Option<(Box2, FocusKind)> {
        self.actions.iter().find_map(|a| match a {
            ScreenAction::FocusRegion { region, kind } => Some((*region, *kind)),
            _ => None,
        })
    }

    /// True if the reply draws anything on screen.
    pub fn draws(&self) -> bool {
        self.actions
            .iter()
            .any(|a| !matches!(a, ScreenAction::FocusRegion { .. } | ScreenAction::Clear))
    }
}

/// One line of the `application/x-ndjson` stream from `POST /api/screen/ask`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    Speech {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Response {
        response: ScreenReply,
        turn_id: String,
    },
    Error {
        message: String,
    },
}

/// Parses and checks one line of the stream. None for anything malformed or out of bounds.
pub fn parse_event(line: &str) -> Option<StreamEvent> {
    let event: StreamEvent = serde_json::from_str(line).ok()?;
    let ok = match &event {
        StreamEvent::Speech { text } => within(text, SPEECH_CHARS),
        StreamEvent::Response { response, turn_id } => reply_is_valid(response) && is_uuid(turn_id),
        StreamEvent::Error { message } => within(message, 300),
    };
    ok.then_some(event)
}

fn reply_is_valid(reply: &ScreenReply) -> bool {
    within(&reply.speech, SPEECH_CHARS)
        && actions_are_valid(&reply.actions)
        && reply.video_time_sec.is_none_or(|t| t <= MAX_VIDEO_SECONDS)
}

pub fn actions_are_valid(actions: &[ScreenAction]) -> bool {
    actions.len() <= MAX_ACTIONS && actions.iter().all(action_is_valid)
}

/// An action the screen tutor may send. Ticks and amber circles are Notes Check's own marks,
/// made here on the device from its findings: a reply that carries them is refused.
fn action_is_valid(action: &ScreenAction) -> bool {
    let label_ok = |label: &Option<String>| label.as_deref().is_none_or(|l| within(l, LABEL_CHARS));
    match action {
        ScreenAction::FocusRegion { region, .. }
        | ScreenAction::Underline { region }
        | ScreenAction::Highlight { region } => box_ok(region),
        ScreenAction::PointAt { point, label } => point_ok(point) && label_ok(label),
        ScreenAction::CircleRegion {
            region,
            label,
            tone,
        } => box_ok(region) && label_ok(label) && tone.is_none(),
        ScreenAction::CheckMark { .. } => false,
        ScreenAction::MarginNote { text, beside, .. } => within(text, NOTE_CHARS) && box_ok(beside),
        ScreenAction::WriteStep { text, beside, .. } => within(text, STEP_CHARS) && box_ok(beside),
        ScreenAction::Clear => true,
    }
}

/// The reply of `POST /api/screen/reanchor`: the same ink moved onto the new screenshot.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReanchorReply {
    pub found: bool,
    pub actions: Vec<ScreenAction>,
}

/// Parses and checks a reanchor reply; None for anything malformed.
pub fn parse_reanchor(body: &[u8]) -> Option<ReanchorReply> {
    let reply: ReanchorReply = serde_json::from_slice(body).ok()?;
    actions_are_valid(&reply.actions).then_some(reply)
}

fn point_ok(p: &Point) -> bool {
    p.x <= 1000 && p.y <= 1000
}

fn box_ok(b: &Box2) -> bool {
    b.left <= b.right && b.top <= b.bottom && b.right <= 1000 && b.bottom <= 1000
}

/// Non-empty, at most `max` characters, no control characters.
pub(super) fn within(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.chars().count() <= max && !text.chars().any(char::is_control)
}

pub(super) fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.char_indices().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// Splits a byte stream into lines as chunks arrive (the reply is newline-delimited JSON).
#[derive(Default)]
pub struct LineSplitter {
    pending: Vec<u8>,
}

/// The longest line accepted (a full reply is a few kilobytes).
const MAX_LINE_BYTES: usize = 64 * 1024;

impl LineSplitter {
    /// Feeds bytes; returns the complete lines they finish. Over-long lines are dropped.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut lines = Vec::new();
        for &byte in bytes {
            if byte == b'\n' {
                if let Ok(line) = std::str::from_utf8(&self.pending) {
                    if !line.trim().is_empty() {
                        lines.push(line.to_owned());
                    }
                }
                self.pending.clear();
            } else if self.pending.len() < MAX_LINE_BYTES {
                self.pending.push(byte);
            }
        }
        lines
    }
}

// ─── Clips ───────────────────────────────────────────────────────────────────────────────────

/// One stroke of tutor ink in a clip, in the clip image's pixels.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClipStroke {
    pub tool: &'static str,
    pub color: String,
    pub width: f32,
    /// [x, y, pressure, t]
    pub points: Vec<[f32; 4]>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSource {
    pub app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_sec: Option<u32>,
    /// RFC 3339, UTC.
    pub captured_at: String,
}

/// Everything in `POST /api/screen/clips` except the image.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipHead {
    pub pixel_ratio: f32,
    pub strokes: Vec<ClipStroke>,
    pub source: ClipSource,
    pub ocr_text: String,
}

/// The JSON body of `POST /api/screen/clips` (the image goes in last, straight into the buffer).
pub fn clip_body(head: &ClipHead, jpeg: &[u8], width: u32, height: u32) -> SecretBytes {
    with_image(head, jpeg, width, height)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipCreated {
    clip_id: String,
}

/// The new clip's id from the server's reply, if it's a UUID.
pub fn parse_clip_created(body: &[u8]) -> Option<String> {
    let created: ClipCreated = serde_json::from_slice(body).ok()?;
    is_uuid(&created.clip_id).then_some(created.clip_id)
}

// ─── Device sign-in ──────────────────────────────────────────────────────────────────────────

/// A link code handed over by the page: 32 URL-safe base64 characters.
pub fn is_link_code(code: &str) -> bool {
    code.len() == 32 && code.bytes().all(is_url_safe)
}

/// A device token as the server issues it: "mewdt_" + 43 URL-safe base64 characters.
pub fn is_device_token(token: &str) -> bool {
    token
        .strip_prefix("mewdt_")
        .is_some_and(|rest| rest.len() == 43 && rest.bytes().all(is_url_safe))
}

fn is_url_safe(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRequest<'a> {
    pub code: &'a str,
    pub verifier: &'a str,
    pub device_name: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedToken {
    pub token: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::frame::{ScreenRect, Timings};

    const TURN: &str = "33333333-3333-4333-8333-333333333333";

    fn meta() -> FrameMeta {
        let rect = ScreenRect {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        FrameMeta {
            kind: TargetKind::Window,
            app: Some("excel.exe".into()),
            bounds: rect,
            monitor: rect,
            dpi: 96,
            width: 1600,
            height: 900,
            timings: Timings::default(),
            video_playing: None,
            window: None,
        }
    }

    #[test]
    fn builds_the_ask_body_the_server_expects() {
        let body = ask_body("what's \"this\"?", &meta(), None, None, b"\xff\xd8\xff");
        let value: serde_json::Value = serde_json::from_slice(body.as_slice()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "transcript": "what's \"this\"?",
                "app": "excel.exe",
                "scope": "window",
                "image": { "jpeg": "/9j/", "width": 1600, "height": 900 }
            })
        );
        let playing = ask_body("hi", &meta(), Some(true), None, b"\xff\xd8\xff");
        let value: serde_json::Value = serde_json::from_slice(playing.as_slice()).unwrap();
        assert_eq!(value["videoPlaying"], true);
        assert!(value.get("walkthroughId").is_none());
        let coached = ask_body("why?", &meta(), None, Some(TURN), b"\xff\xd8\xff");
        let value: serde_json::Value = serde_json::from_slice(coached.as_slice()).unwrap();
        assert_eq!(value["walkthroughId"], TURN);
    }

    #[test]
    fn builds_the_reanchor_and_clip_bodies() {
        let previous = [ScreenAction::Underline {
            region: Box2 {
                left: 1,
                top: 2,
                right: 3,
                bottom: 4,
            },
        }];
        let body = reanchor_body(
            &meta(),
            FocusKind::Question,
            "Question 3",
            &previous,
            b"\xff",
        );
        let value: serde_json::Value = serde_json::from_slice(body.as_slice()).unwrap();
        assert_eq!(value["focus"]["kind"], "question");
        assert_eq!(value["previous"][0]["type"], "underline");
        assert_eq!(value["image"]["width"], 1600);

        let head = ClipHead {
            pixel_ratio: 1.5,
            strokes: vec![ClipStroke {
                tool: "pen",
                color: "#8a7bf0".into(),
                width: 3.0,
                points: vec![[1.0, 2.0, 0.5, 0.0]],
            }],
            source: ClipSource {
                app: "msedge.exe".into(),
                title: None,
                url: Some("https://example.com/".into()),
                timestamp_sec: None,
                captured_at: "2026-10-22T10:00:00Z".into(),
            },
            ocr_text: "Question 3".into(),
        };
        let body = clip_body(&head, b"\xff\xd8", 640, 320);
        let value: serde_json::Value = serde_json::from_slice(body.as_slice()).unwrap();
        assert_eq!(value["pixelRatio"], 1.5);
        assert_eq!(value["source"]["url"], "https://example.com/");
        assert!(value["source"].get("title").is_none());
        assert_eq!(value["strokes"][0]["points"][0][2], 0.5);
        assert_eq!(
            value["image"],
            serde_json::json!({ "jpeg": "/9g=", "width": 640, "height": 320 })
        );
        assert_eq!(
            parse_clip_created(format!(r#"{{"clipId":"{TURN}"}}"#).as_bytes()).as_deref(),
            Some(TURN)
        );
        assert_eq!(parse_clip_created(br#"{"clipId":"../x"}"#), None);
    }

    #[test]
    fn moves_every_coordinate_of_an_action() {
        let note = ScreenAction::MarginNote {
            text: "Hint".into(),
            beside: Box2 {
                left: 100,
                top: 100,
                right: 200,
                bottom: 150,
            },
            side: None,
        };
        let moved = note.map_coordinates(|x, y| (x + 10, y.saturating_sub(50)));
        assert_eq!(
            moved,
            ScreenAction::MarginNote {
                text: "Hint".into(),
                beside: Box2 {
                    left: 110,
                    top: 50,
                    right: 210,
                    bottom: 100
                },
                side: None,
            }
        );
        assert_eq!(moved.texts(), vec!["Hint"]);
    }

    #[test]
    fn cleans_the_transcript_from_the_page() {
        assert_eq!(clean_transcript("  hi\u{0}\n there  "), "hi there");
        assert_eq!(clean_transcript(&"x".repeat(900)).len(), TRANSCRIPT_CHARS);
    }

    #[test]
    fn parses_each_kind_of_event() {
        assert_eq!(
            parse_event(r#"{"type":"speech","text":"Hello.","latencyMs":400}"#),
            Some(StreamEvent::Speech {
                text: "Hello.".into()
            })
        );
        let response = format!(
            r#"{{"type":"response","turnId":"{TURN}","latencyMs":900,"response":{{"speech":"Click here.","mode":"answer","videoTimeSec":754,"actions":[{{"type":"focus_region","box":{{"left":0,"top":0,"right":500,"bottom":500}},"kind":"video_frame"}},{{"type":"point_at","point":{{"x":120,"y":40}},"label":"Insert"}},{{"type":"circle_region","box":{{"left":1,"top":2,"right":3,"bottom":4}}}},{{"type":"margin_note","text":"Note","besideBox":{{"left":1,"top":2,"right":3,"bottom":4}},"side":"auto"}},{{"type":"write_step","latexOrText":"F = ma","besideBox":{{"left":1,"top":2,"right":3,"bottom":4}}}},{{"type":"highlight","box":{{"left":1,"top":2,"right":3,"bottom":4}}}},{{"type":"clear"}}]}}}}"#
        );
        let Some(StreamEvent::Response { response, turn_id }) = parse_event(&response) else {
            panic!("response")
        };
        assert_eq!(turn_id, TURN);
        assert_eq!(response.actions.len(), 7);
        assert_eq!(response.video_time_sec, Some(754));
        assert!(response.draws());
        assert_eq!(
            response.focus().map(|(_, kind)| kind),
            Some(FocusKind::VideoFrame)
        );
        assert_eq!(
            parse_event(r#"{"type":"error","message":"Busy."}"#),
            Some(StreamEvent::Error {
                message: "Busy.".into()
            })
        );
    }

    #[test]
    fn rejects_anything_out_of_bounds_or_unexpected() {
        let reply = |actions: &str| {
            format!(
                r#"{{"type":"response","turnId":"{TURN}","latencyMs":1,"response":{{"speech":"Hi.","mode":"answer","actions":[{actions}]}}}}"#
            )
        };
        for bad in [
            reply(r#"{"type":"point_at","point":{"x":1001,"y":0}}"#),
            reply(r#"{"type":"circle_region","box":{"left":9,"top":0,"right":1,"bottom":5}}"#),
            reply(&format!(r#"{{"type":"margin_note","text":"{}","besideBox":{{"left":1,"top":1,"right":2,"bottom":2}}}}"#, "x".repeat(81))),
            reply(r#"{"type":"screen_note","text":"old","near":{"x":1,"y":1}}"#),
            reply(r#"{"type":"focus_region","box":{"left":1,"top":1,"right":2,"bottom":2},"kind":"poster"}"#),
            reply(r#"{"type":"point_at","point":{"x":1,"y":1},"onclick":"run()"}"#),
            reply(r#"{"type":"open_url","url":"https://evil.example"}"#),
            format!(r#"{{"type":"speech","text":"{}"}}"#, "x".repeat(301)),
            r#"{"type":"speech","text":"  "}"#.to_owned(),
            r#"{"type":"response","turnId":"not-a-uuid","response":{"speech":"Hi.","mode":"answer","actions":[]}}"#.to_owned(),
            "not json".to_owned(),
        ] {
            assert_eq!(parse_event(&bad), None, "{bad}");
        }
    }

    #[test]
    fn splits_lines_across_chunks() {
        let mut splitter = LineSplitter::default();
        assert!(splitter.push(b"{\"a\":").is_empty());
        assert_eq!(
            splitter.push(b"1}\n{\"b\":2}\n\n{\"c\""),
            vec!["{\"a\":1}", "{\"b\":2}"]
        );
        assert_eq!(splitter.push(b":3}\n"), vec!["{\"c\":3}"]);
    }

    #[test]
    fn recognises_codes_and_tokens() {
        assert!(is_link_code(&"c".repeat(32)));
        assert!(!is_link_code(&"c".repeat(31)));
        assert!(!is_link_code(&format!("{}/", "c".repeat(31))));
        assert!(is_device_token(&format!("mewdt_{}", "A".repeat(43))));
        assert!(!is_device_token(&format!("mewdt_{}", "A".repeat(42))));
        assert!(!is_device_token(&format!("other_{}", "A".repeat(43))));
    }
}
