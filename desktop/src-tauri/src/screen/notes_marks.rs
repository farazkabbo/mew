//! Notes Check on the desktop (docs/SCREEN_COACH_NOTES_CHECK.md, N4), the pure parts: what is
//! sent (the screen's text blocks, never the picture), checking the server's reply, and turning
//! its findings into marks beside the blocks they're about. No I/O: fully tested.
//!
//! Marks (brief §8): a match gets a small tick, a difference an amber circle, a gap a soft
//! highlight; "unclear" gets nothing on screen (it's a question in the panel and the notebook).

use serde::{Deserialize, Serialize};

use super::frame::ScreenRect;
use super::protocol::{is_uuid, within, Box2, FocusKind, InkTone, ScreenAction};
use super::screen_text::TextBlock;
use super::secret::SecretBytes;

/// Caps on a reply (packages/shared/src/notes-check.ts NOTES_CHECK_LIMITS).
const MAX_FINDINGS: usize = 24;
const SPEECH_CHARS: usize = 400;
const QUOTE_CHARS: usize = 200;
const QUESTION_CHARS: usize = 240;
const SHORT_CHARS: usize = 300;

/// Where the material came from, for the link chips of matched lines (a trimmed link, as for
/// clips; the title only alongside it).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesSource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_sec: Option<u32>,
}

/// The JSON body of `POST /api/screen/notes-check`, in a wipeable buffer (it holds screen text).
pub fn notes_check_body(
    blocks: &[TextBlock],
    app: Option<&str>,
    all_notes: bool,
    source: &NotesSource,
) -> SecretBytes {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Block<'a> {
        block_id: &'a str,
        text: &'a str,
    }
    #[derive(Serialize)]
    struct Body<'a> {
        screen: Vec<Block<'a>>,
        app: Option<&'a str>,
        scope: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<&'a NotesSource>,
    }
    let body = Body {
        screen: blocks
            .iter()
            .map(|b| Block {
                block_id: &b.id,
                text: &b.text,
            })
            .collect(),
        app,
        scope: if all_notes { "all" } else { "default" },
        source: source.url.as_ref().map(|_| source),
    };
    SecretBytes::from_vec(serde_json::to_vec(&body).unwrap_or_default())
}

// ─── The reply ───────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingKind {
    Match,
    Difference,
    Gap,
    Unclear,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: FindingKind,
    pub line_ids: Vec<String>,
    pub block_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_quote: Option<String>,
    pub screen_quote: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insert_after_line_id: Option<String>,
    pub source_conflict: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concept_hint: Option<String>,
    pub confidence: f32,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NotesPage {
    pub page_id: String,
    pub notebook_id: String,
    pub notebook_title: String,
    pub page_index: u32,
}

/// What the matched lines link to (passed on to the page; checked there again).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CheckedSource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp_sec: Option<u32>,
}

/// What `POST /api/screen/notes-check` answers (packages/shared/src/notes-check.ts).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NotesCheckReply {
    pub check_id: Option<String>,
    pub related: bool,
    pub topic: String,
    pub speech: String,
    pub scope_label: String,
    pub pages: Vec<NotesPage>,
    pub findings: Vec<Finding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<CheckedSource>,
    pub latency_ms: u64,
}

/// Parses and checks a reply; None for anything malformed (nothing of it is shown then).
pub fn parse_notes_reply(body: &[u8]) -> Option<NotesCheckReply> {
    let reply: NotesCheckReply = serde_json::from_slice(body).ok()?;
    let text_ok = |text: &str, max: usize| text.is_empty() || within(text, max);
    let optional_ok =
        |text: &Option<String>, max: usize| text.as_deref().is_none_or(|t| within(t, max));
    let ok = within(&reply.speech, SPEECH_CHARS)
        && text_ok(&reply.topic, SHORT_CHARS)
        && text_ok(&reply.scope_label, SHORT_CHARS)
        && reply.check_id.as_deref().is_none_or(is_uuid)
        && reply.source.as_ref().is_none_or(|s| {
            s.clip_id.as_deref().is_none_or(is_uuid)
                && s.url
                    .as_deref()
                    .is_none_or(|u| u.starts_with("https://") && within(u, 2000))
                && optional_ok(&s.title, 200)
        })
        && reply.findings.len() <= MAX_FINDINGS
        && reply.pages.iter().all(|p| {
            is_uuid(&p.page_id) && is_uuid(&p.notebook_id) && within(&p.notebook_title, 200)
        })
        && reply.findings.iter().all(|f| {
            is_uuid(&f.id)
                && f.line_ids.iter().all(|id| is_uuid(id))
                && !f.block_ids.is_empty()
                && f.block_ids.iter().all(|id| block_id_ok(id))
                && within(&f.screen_quote, QUOTE_CHARS)
                && optional_ok(&f.note_quote, QUOTE_CHARS)
                && optional_ok(&f.question, QUESTION_CHARS)
                && optional_ok(&f.concept_hint, 80)
                && f.insert_after_line_id.as_deref().is_none_or(is_uuid)
                && (0.0..=1.0).contains(&f.confidence)
        });
    ok.then_some(reply)
}

fn block_id_ok(id: &str) -> bool {
    (1..=16).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// ─── Marks ───────────────────────────────────────────────────────────────────────────────────

/// The overlay's actions for a check: a focus region around everything marked (so "show that
/// again" can find it), then one mark per block, the most important kind winning (a block can't
/// be circled and ticked at once). Block ids the device didn't send are ignored.
pub fn notes_marks(
    findings: &[Finding],
    blocks: &[TextBlock],
    bounds: ScreenRect,
) -> Vec<ScreenAction> {
    let priority = |kind: FindingKind| match kind {
        FindingKind::Difference => 3,
        FindingKind::Gap => 2,
        FindingKind::Match => 1,
        FindingKind::Unclear => 0,
    };
    let mut marked: Vec<(&TextBlock, FindingKind)> = Vec::new();
    for finding in findings.iter().filter(|f| priority(f.kind) > 0) {
        for id in &finding.block_ids {
            let Some(block) = blocks.iter().find(|b| &b.id == id) else {
                continue;
            };
            match marked.iter_mut().find(|(b, _)| b.id == block.id) {
                Some((_, kind)) if priority(finding.kind) > priority(*kind) => *kind = finding.kind,
                Some(_) => {}
                None => marked.push((block, finding.kind)),
            }
        }
    }
    let Some(around) = super::screen_text::union(marked.iter().map(|(b, _)| b.rect)) else {
        return Vec::new();
    };
    let mut actions = vec![ScreenAction::FocusRegion {
        region: normalised(around, bounds),
        kind: FocusKind::Text,
    }];
    actions.extend(marked.into_iter().map(|(block, kind)| {
        let region = normalised(block.rect, bounds);
        match kind {
            FindingKind::Difference => ScreenAction::CircleRegion {
                region,
                label: None,
                tone: Some(InkTone::Question),
            },
            FindingKind::Gap => ScreenAction::Highlight { region },
            _ => ScreenAction::CheckMark { region },
        }
    }));
    actions
}

/// A rectangle on screen → 0–1000 across the captured area (clamped to it).
fn normalised(rect: ScreenRect, bounds: ScreenRect) -> Box2 {
    let (w, h) = (bounds.width().max(1) as f32, bounds.height().max(1) as f32);
    let x = |v: i32| {
        (((v - bounds.left) as f32 / w) * 1000.0)
            .round()
            .clamp(0.0, 1000.0) as u16
    };
    let y = |v: i32| {
        (((v - bounds.top) as f32 / h) * 1000.0)
            .round()
            .clamp(0.0, 1000.0) as u16
    };
    Box2 {
        left: x(rect.left),
        top: y(rect.top),
        right: x(rect.right),
        bottom: y(rect.bottom),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::privacy::detect::RedactionRules;
    use crate::screen::privacy::redact::{OcrLine, OcrWord};
    use crate::screen::screen_text::ScreenText;

    const BOUNDS: ScreenRect = ScreenRect {
        left: 0,
        top: 0,
        right: 1000,
        bottom: 1000,
    };

    /// Three blocks far apart: b1 at y 0, b2 at y 200, b3 at y 400.
    fn blocks() -> Vec<TextBlock> {
        let lines: Vec<OcrLine> = [
            "Enzymes are catalysts",
            "They are not consumed",
            "Activation energy",
        ]
        .iter()
        .enumerate()
        .map(|(i, text)| OcrLine {
            words: text
                .split(' ')
                .enumerate()
                .map(|(c, w)| OcrWord {
                    text: w.to_owned(),
                    x: c as f32 * 60.0,
                    y: i as f32 * 200.0,
                    width: 50.0,
                    height: 20.0,
                })
                .collect(),
        })
        .collect();
        ScreenText::from_ocr(&lines, 1.0, (1000, 1000), BOUNDS, &[])
            .blocks(&RedactionRules::default())
    }

    fn finding(kind: FindingKind, block: &str) -> Finding {
        Finding {
            id: "11111111-1111-4111-8111-111111111111".into(),
            kind,
            line_ids: vec![],
            block_ids: vec![block.into()],
            note_quote: None,
            screen_quote: "x".into(),
            question: None,
            insert_after_line_id: None,
            source_conflict: false,
            concept_hint: None,
            confidence: 0.9,
            evidence: vec!["model".into()],
        }
    }

    #[test]
    fn sends_the_blocks_words_and_never_where_they_are() {
        let body = notes_check_body(
            &blocks(),
            Some("msedge.exe"),
            false,
            &NotesSource::default(),
        );
        let json: serde_json::Value = serde_json::from_slice(body.as_slice()).unwrap();
        assert_eq!(json["scope"], "default");
        assert_eq!(json["screen"][1]["blockId"], "b2");
        assert_eq!(json["screen"][1]["text"], "They are not consumed");
        assert!(json["screen"][0].get("rect").is_none());
        assert!(json.get("source").is_none(), "no link, no source");

        let source = NotesSource {
            url: Some("https://www.youtube.com/watch?v=abc".into()),
            title: Some("Enzymes".into()),
            timestamp_sec: Some(754),
        };
        let body = notes_check_body(&blocks(), None, true, &source);
        let json: serde_json::Value = serde_json::from_slice(body.as_slice()).unwrap();
        assert_eq!(json["scope"], "all");
        assert_eq!(json["source"]["timestampSec"], 754);
    }

    #[test]
    fn marks_each_block_once_with_the_most_important_kind() {
        let findings = [
            finding(FindingKind::Match, "b1"),
            finding(FindingKind::Difference, "b2"),
            finding(FindingKind::Match, "b2"),
            finding(FindingKind::Gap, "b3"),
            finding(FindingKind::Unclear, "b1"),
            finding(FindingKind::Match, "b9"),
        ];
        let marks = notes_marks(&findings, &blocks(), BOUNDS);
        assert!(matches!(
            marks[0],
            ScreenAction::FocusRegion {
                kind: FocusKind::Text,
                ..
            }
        ));
        let kinds: Vec<&str> = marks[1..]
            .iter()
            .map(|m| match m {
                ScreenAction::CheckMark { .. } => "tick",
                ScreenAction::CircleRegion {
                    tone: Some(InkTone::Question),
                    ..
                } => "amber circle",
                ScreenAction::Highlight { .. } => "highlight",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, ["tick", "amber circle", "highlight"]);
        let ScreenAction::CheckMark { region } = &marks[1] else {
            unreachable!()
        };
        assert_eq!((region.top, region.bottom), (0, 20));
    }

    #[test]
    fn draws_nothing_for_unclear_findings_alone() {
        assert!(notes_marks(&[finding(FindingKind::Unclear, "b1")], &blocks(), BOUNDS).is_empty());
    }

    fn reply(findings: &str) -> String {
        format!(
            r#"{{"checkId":null,"related":true,"topic":"Enzymes","speech":"Most of this matches your notes.","scopeLabel":"Compared with Biology, page 3","pages":[],"findings":{findings},"latencyMs":2100}}"#
        )
    }

    #[test]
    fn accepts_a_well_formed_reply() {
        let one = r#"[{"id":"11111111-1111-4111-8111-111111111111","type":"difference","lineIds":["22222222-2222-4222-8222-222222222222"],"blockIds":["b2"],"noteQuote":"used up","screenQuote":"not consumed","question":"What does the slide say?","sourceConflict":false,"confidence":0.9,"evidence":["model","second_opinion"]}]"#;
        let parsed = parse_notes_reply(reply(one).as_bytes()).expect("valid");
        assert_eq!(parsed.findings[0].kind, FindingKind::Difference);
    }

    #[test]
    fn refuses_malformed_replies() {
        let base = r#"{"id":"11111111-1111-4111-8111-111111111111","type":"match","lineIds":[],"blockIds":["b1"],"screenQuote":"x","sourceConflict":false,"confidence":0.9,"evidence":[]}"#;
        for bad in [
            base.replace("\"b1\"", "\"b 1\""),
            base.replace("\"blockIds\":[\"b1\"]", "\"blockIds\":[]"),
            base.replace("1111-4111", "nope"),
            base.replace("0.9", "1.5"),
            base.replace("\"x\"", "\"bell\\u0007\""),
            base.replace("\"evidence\":[]", "\"evidence\":[],\"script\":\"x\""),
        ] {
            assert!(
                parse_notes_reply(reply(&format!("[{bad}]")).as_bytes()).is_none(),
                "{bad}"
            );
        }
        let many = vec![base; 25].join(",");
        assert!(parse_notes_reply(reply(&format!("[{many}]")).as_bytes()).is_none());
    }
}
