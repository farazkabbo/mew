//! What Circle & Ask sends to the web app's server and gets back (S3.2; mirrors
//! packages/shared/src/circle.ts). Pure: no I/O, fully tested.
//!
//! Requests carry screen pixels, so they're built straight into wipeable buffers
//! (`SecretBytes`), like the other screen requests. Everything that comes back is checked here
//! before anything is drawn, said or saved.

use serde::{Deserialize, Serialize};

use super::base64;
use super::marks::{MarkKind, NormPoint};
use super::protocol::{actions_are_valid, is_uuid, within, Box2, ScreenAction, SPEECH_CHARS};
use super::secret::SecretBytes;

pub const SAY_CHARS: usize = 220;
pub const QUESTION_CHARS: usize = 500;
pub const SUMMARY_CHARS: usize = 320;
pub const FOLLOW_UP_CHARS: usize = 220;
pub const CONCEPT_CHARS: usize = 80;
pub const MAX_STEPS: usize = 5;
const MAX_CONCEPTS: usize = 5;

// ─── Asking ──────────────────────────────────────────────────────────────────────────────────

/// How the student asked (`CircleAskQuestion`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum Question {
    Voice {
        text: String,
    },
    Typed {
        text: String,
    },
    ScreenSelection {
        text: String,
        handwritten: bool,
        confidence: f32,
    },
    /// Enter: "explain this".
    None,
}

impl Question {
    /// The words, or "Explain this" (what an entry's note shows).
    pub fn label(&self) -> &str {
        match self {
            Question::Voice { text }
            | Question::Typed { text }
            | Question::ScreenSelection { text, .. } => text,
            Question::None => "Explain this",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MarkOut {
    pub number: u8,
    pub kind: MarkKind,
    #[serde(rename = "box")]
    pub region: Box2,
    pub polygon: Vec<NormPoint>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BlockOut {
    pub id: String,
    pub text: String,
    #[serde(rename = "box")]
    pub region: Box2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentKind {
    Browser,
    Pdf,
    Video,
    App,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Turn {
    pub question: String,
    pub summary: String,
}

/// Everything in `POST /api/screen/circle-ask` except the two images.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskHead {
    pub session_id: String,
    pub question: Question,
    pub marks: Vec<MarkOut>,
    pub blocks: Vec<BlockOut>,
    pub app: Option<String>,
    pub kind: ContentKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceOut>,
    pub history: Vec<Turn>,
}

/// A JPEG and its size.
pub struct Jpeg<'a> {
    pub bytes: &'a [u8],
    pub width: u32,
    pub height: u32,
}

/// The JSON body of `POST /api/screen/circle-ask`: `head`, then
/// `"focus": {"image": …, "widthPx", "heightPx"}` and `"context": …`, the images base64-encoded in
/// place into a buffer sized exactly up front (growing it would leave unwiped copies behind).
pub fn ask_body(
    head: &AskHead,
    focus: Jpeg<'_>,
    focus_px: (u32, u32),
    context: Jpeg<'_>,
) -> SecretBytes {
    // Serialising plain strings, numbers and options can't fail.
    let head = serde_json::to_string(head).unwrap_or_else(|_| "{}".to_owned());
    let open = head.strip_suffix('}').unwrap_or("{");
    let focus_key = r#","focus":{"image":"#;
    let focus_px = format!(r#","widthPx":{},"heightPx":{}}}"#, focus_px.0, focus_px.1);
    let context_key = r#","context":"#;
    let total = open.len()
        + focus_key.len()
        + image_len(&focus)
        + focus_px.len()
        + context_key.len()
        + image_len(&context)
        + 1;
    let mut body = Vec::with_capacity(total);
    body.extend_from_slice(open.as_bytes());
    body.extend_from_slice(focus_key.as_bytes());
    push_image(&mut body, &focus);
    body.extend_from_slice(focus_px.as_bytes());
    body.extend_from_slice(context_key.as_bytes());
    push_image(&mut body, &context);
    body.push(b'}');
    debug_assert_eq!(body.len(), total);
    SecretBytes::from_vec(body)
}

fn image_tail(image: &Jpeg<'_>) -> String {
    format!(r#"","width":{},"height":{}}}"#, image.width, image.height)
}

fn image_len(image: &Jpeg<'_>) -> usize {
    r#"{"jpeg":""#.len() + base64::encoded_len(image.bytes.len()) + image_tail(image).len()
}

/// `{"jpeg":"<base64>","width":…,"height":…}`
fn push_image(body: &mut Vec<u8>, image: &Jpeg<'_>) {
    body.extend_from_slice(br#"{"jpeg":""#);
    base64::encode_into(image.bytes, body);
    body.extend_from_slice(image_tail(image).as_bytes());
}

/// `POST /api/screen/read-question`: the selected area, as a JPEG.
pub fn read_question_body(image: Jpeg<'_>) -> SecretBytes {
    let total = r#"{"image":"#.len() + image_len(&image) + 1;
    let mut body = Vec::with_capacity(total);
    body.extend_from_slice(br#"{"image":"#);
    push_image(&mut body, &image);
    body.push(b'}');
    debug_assert_eq!(body.len(), total);
    SecretBytes::from_vec(body)
}

// ─── The answer ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub index: usize,
    pub say: String,
    pub actions: Vec<ScreenAction>,
}

/// One line of the `application/x-ndjson` stream from `POST /api/screen/circle-ask`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CircleEvent {
    Step {
        step: Step,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        turn_id: String,
        read_question: String,
        summary: String,
        follow_up_question: Option<String>,
        concept_hints: Vec<String>,
    },
    /// A step failed the safety check: take back what was drawn, say this instead.
    Abort {
        speech: String,
    },
    Error {
        message: String,
    },
}

/// Parses and checks one line of the stream; None for anything malformed or out of bounds.
pub fn parse_circle_event(line: &str) -> Option<CircleEvent> {
    let event: CircleEvent = serde_json::from_str(line).ok()?;
    let ok = match &event {
        CircleEvent::Step { step } => {
            step.index < MAX_STEPS
                && within(&step.say, SAY_CHARS)
                && actions_are_valid(&step.actions)
                // The tutor's own drawing only: no focus regions or clearing from a step.
                && step
                    .actions
                    .iter()
                    .all(|a| !matches!(a, ScreenAction::FocusRegion { .. } | ScreenAction::Clear))
        }
        CircleEvent::Done {
            turn_id,
            read_question,
            summary,
            follow_up_question,
            concept_hints,
        } => {
            is_uuid(turn_id)
                && within(read_question, QUESTION_CHARS)
                && within(summary, SUMMARY_CHARS)
                && follow_up_question
                    .as_deref()
                    .is_none_or(|q| within(q, FOLLOW_UP_CHARS))
                && concept_hints.len() <= MAX_CONCEPTS
                && concept_hints.iter().all(|c| within(c, CONCEPT_CHARS))
        }
        CircleEvent::Abort { speech } => within(speech, SPEECH_CHARS),
        CircleEvent::Error { message } => within(message, 300),
    };
    ok.then_some(event)
}

/// What the server read in a selected area (`ReadQuestionResponse`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadQuestion {
    pub questions: Vec<String>,
    pub handwritten: bool,
    pub confidence: f32,
}

pub fn parse_read_question(body: &[u8]) -> Option<ReadQuestion> {
    let read: ReadQuestion = serde_json::from_slice(body).ok()?;
    let ok = read.questions.len() <= 5
        && read.questions.iter().all(|q| within(q, QUESTION_CHARS))
        && (0.0..=1.0).contains(&read.confidence);
    ok.then_some(read)
}

/// Below this, a question read from the screen is shown back to the student first (§3.5).
pub const CONFIRM_BELOW: f32 = 0.7;

/// The questions in a block of printed text: one per line ending in "?", or the whole text when
/// none does. Several → the student picks one (never guessed).
pub fn questions_in(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let asked: Vec<String> = lines
        .iter()
        .filter(|l| l.ends_with('?'))
        .map(|l| clip_chars(l, QUESTION_CHARS))
        .collect();
    if !asked.is_empty() {
        return asked.into_iter().take(5).collect();
    }
    let all = lines.join(" ");
    if all.is_empty() {
        Vec::new()
    } else {
        vec![clip_chars(&all, QUESTION_CHARS)]
    }
}

/// Cleans a question from a page (typed in the card): no control characters, length capped.
pub fn clean_question(raw: &str) -> String {
    let text: String = raw.chars().filter(|c| !c.is_control()).collect();
    clip_chars(text.trim(), QUESTION_CHARS)
}

fn clip_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TURN: &str = "33333333-3333-4333-8333-333333333333";
    const SESSION: &str = "11111111-1111-4111-8111-111111111111";

    fn head() -> AskHead {
        AskHead {
            session_id: SESSION.into(),
            question: Question::None,
            marks: vec![MarkOut {
                number: 1,
                kind: MarkKind::Circle,
                region: Box2 {
                    left: 100,
                    top: 100,
                    right: 900,
                    bottom: 900,
                },
                polygon: vec![NormPoint { x: 100, y: 500 }],
                text: "velocity".into(),
            }],
            blocks: vec![BlockOut {
                id: "b1".into(),
                text: "Figure 2".into(),
                region: Box2 {
                    left: 0,
                    top: 950,
                    right: 500,
                    bottom: 1000,
                },
            }],
            app: Some("msedge.exe".into()),
            kind: ContentKind::Video,
            source: None,
            history: vec![],
        }
    }

    #[test]
    fn builds_the_ask_body_with_both_images() {
        let body = ask_body(
            &head(),
            Jpeg {
                bytes: b"\xff\xd8",
                width: 800,
                height: 400,
            },
            (1200, 600),
            Jpeg {
                bytes: b"\xff\xd8\xff",
                width: 1600,
                height: 900,
            },
        );
        let value: serde_json::Value = serde_json::from_slice(body.as_slice()).unwrap();
        assert_eq!(value["sessionId"], SESSION);
        assert_eq!(value["question"], serde_json::json!({ "source": "none" }));
        assert_eq!(value["marks"][0]["kind"], "circle");
        assert_eq!(value["marks"][0]["box"]["right"], 900);
        assert_eq!(value["blocks"][0]["id"], "b1");
        assert_eq!(value["kind"], "video");
        assert!(value.get("source").is_none());
        assert_eq!(
            value["focus"],
            serde_json::json!({
                "image": { "jpeg": "/9g=", "width": 800, "height": 400 },
                "widthPx": 1200,
                "heightPx": 600
            })
        );
        assert_eq!(
            value["context"],
            serde_json::json!({ "jpeg": "/9j/", "width": 1600, "height": 900 })
        );

        let typed = AskHead {
            question: Question::ScreenSelection {
                text: "Q3?".into(),
                handwritten: true,
                confidence: 0.5,
            },
            ..head()
        };
        let body = ask_body(
            &typed,
            Jpeg {
                bytes: b"\xff",
                width: 1,
                height: 1,
            },
            (1, 1),
            Jpeg {
                bytes: b"\xff",
                width: 1,
                height: 1,
            },
        );
        let value: serde_json::Value = serde_json::from_slice(body.as_slice()).unwrap();
        assert_eq!(value["question"]["source"], "screen_selection");
        assert_eq!(value["question"]["handwritten"], true);
    }

    #[test]
    fn builds_the_read_question_body() {
        let body = read_question_body(Jpeg {
            bytes: b"\xff\xd8",
            width: 300,
            height: 80,
        });
        let value: serde_json::Value = serde_json::from_slice(body.as_slice()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "image": { "jpeg": "/9g=", "width": 300, "height": 80 } })
        );
    }

    #[test]
    fn parses_each_kind_of_event() {
        let step = r#"{"type":"step","latencyMs":900,"step":{"index":0,"say":"This axis is velocity.","actions":[{"type":"underline","box":{"left":1,"top":2,"right":3,"bottom":4}}]}}"#;
        assert!(matches!(
            parse_circle_event(step),
            Some(CircleEvent::Step { step }) if step.index == 0 && step.actions.len() == 1
        ));
        let done = format!(
            r#"{{"type":"done","turnId":"{TURN}","readQuestion":"Explain this","summary":"A flat line means constant speed.","followUpQuestion":null,"conceptHints":["Acceleration"],"latencyMs":1500}}"#
        );
        assert!(matches!(
            parse_circle_event(&done),
            Some(CircleEvent::Done { .. })
        ));
        assert!(matches!(
            parse_circle_event(r#"{"type":"abort","speech":"I can't help with that part."}"#),
            Some(CircleEvent::Abort { .. })
        ));
        assert!(matches!(
            parse_circle_event(r#"{"type":"error","message":"Busy."}"#),
            Some(CircleEvent::Error { .. })
        ));
    }

    #[test]
    fn refuses_anything_out_of_bounds() {
        let step = |inner: &str| format!(r#"{{"type":"step","latencyMs":1,"step":{inner}}}"#);
        for bad in [
            step(r#"{"index":5,"say":"x","actions":[]}"#),
            step(&format!(r#"{{"index":0,"say":"{}","actions":[]}}"#, "x".repeat(221))),
            step(r#"{"index":0,"say":"  ","actions":[]}"#),
            step(r#"{"index":0,"say":"x","actions":[{"type":"clear"}]}"#),
            step(r#"{"index":0,"say":"x","actions":[{"type":"check_mark","box":{"left":1,"top":1,"right":2,"bottom":2}}]}"#),
            step(r#"{"index":0,"say":"x","actions":[],"extra":1}"#),
            r#"{"type":"done","turnId":"x","readQuestion":"q","summary":"s","followUpQuestion":null,"conceptHints":[]}"#.to_owned(),
            r#"{"type":"open_url","url":"https://evil.example"}"#.to_owned(),
            "not json".to_owned(),
        ] {
            assert_eq!(parse_circle_event(&bad), None, "{bad}");
        }
    }

    #[test]
    fn finds_the_questions_in_printed_text() {
        assert_eq!(
            questions_in("Homework 3\nWhat is the slope here?\nWhy is it flat?\n"),
            vec!["What is the slope here?", "Why is it flat?"]
        );
        assert_eq!(
            questions_in("Explain the graph\nin two lines"),
            vec!["Explain the graph in two lines"]
        );
        assert!(questions_in("  \n ").is_empty());
        assert_eq!(clean_question("  why\u{7}?  "), "why?");
        assert_eq!(
            parse_read_question(br#"{"questions":["Find x"],"handwritten":true,"confidence":0.6}"#)
                .map(|r| r.questions),
            Some(vec!["Find x".to_owned()])
        );
        assert_eq!(
            parse_read_question(br#"{"questions":[],"handwritten":true,"confidence":1.5}"#),
            None
        );
    }
}
