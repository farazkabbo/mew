//! The handoff package (docs/HANDOFF_FEATURE.md §6), built on the sender's computer from the
//! session: every text redacted (`redact.rs`), moments numbered m1…m6 in the order they
//! happened, crops already blurred. The preview shows exactly this; Send encrypts exactly this
//! (`plaintext`). Mirrors `HandoffManifest` and `HandoffPlaintext` in packages/shared/src/handoff.ts.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::redact::{self, Found, Kind};
use super::timeline::{Moment, Snapshot};

const FIELD: usize = 600;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cited {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moment_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Next {
    pub text: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Brief {
    pub title: String,
    #[serde(rename = "where")]
    pub where_: String,
    pub goal: String,
    pub tried: Vec<Cited>,
    pub blockers: Vec<Cited>,
    pub next: Vec<Next>,
    pub open_questions: Vec<String>,
}

impl Brief {
    /// From the server's (or the preview's) JSON, checked and cleaned: lengths capped, citations
    /// only to moments that exist, every text redacted again (an edit can't bring a secret back).
    pub fn checked(value: &Value, moment_ids: &[String]) -> Option<(Brief, Found)> {
        let mut brief: Brief = serde_json::from_value(value.clone()).ok()?;
        let mut found = Found::new();
        let mut clean = |t: &str, max: usize| {
            let (text, f) = redact::redact(
                &t.chars()
                    .filter(|c| !c.is_control() || *c == '\n')
                    .take(max)
                    .collect::<String>(),
            );
            redact::merge(&mut found, &f);
            text.trim().to_owned()
        };
        brief.title = clean(&brief.title, 120);
        if brief.title.is_empty() {
            brief.title = "Handoff".into();
        }
        brief.where_ = clean(&brief.where_, FIELD);
        brief.goal = clean(&brief.goal, FIELD);
        let cite = |id: Option<String>| id.filter(|i| moment_ids.contains(i));
        brief.tried = brief
            .tried
            .into_iter()
            .take(8)
            .map(|c| Cited {
                text: c.text,
                moment_id: cite(c.moment_id),
            })
            .collect();
        brief.blockers = brief
            .blockers
            .into_iter()
            .take(8)
            .map(|c| Cited {
                text: c.text,
                moment_id: cite(c.moment_id),
            })
            .collect();
        for c in brief.tried.iter_mut().chain(brief.blockers.iter_mut()) {
            c.text = clean(&c.text, FIELD);
        }
        brief.tried.retain(|c| !c.text.is_empty());
        brief.blockers.retain(|c| !c.text.is_empty());
        brief.next.truncate(3);
        brief
            .next
            .retain(|n| matches!(n.kind.as_str(), "click" | "command" | "open" | "decide"));
        for n in &mut brief.next {
            n.text = clean(&n.text, FIELD);
            n.target = n
                .target
                .as_deref()
                .map(|t| clean(t, 300))
                .filter(|t| !t.is_empty());
        }
        brief.next.retain(|n| !n.text.is_empty());
        brief.open_questions = brief
            .open_questions
            .iter()
            .take(5)
            .map(|q| clean(q, FIELD))
            .filter(|q| !q.is_empty())
            .collect();
        Some((brief, found))
    }

    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// One moment in a draft: its number, whether it's included, and its redacted content.
#[derive(Debug, Clone, PartialEq)]
pub struct DraftMoment {
    pub id: String,
    pub include: bool,
    pub moment: Moment,
    /// The crop after blurring (JPEG bytes).
    pub crop: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Draft {
    pub sender_name: String,
    pub language: String,
    pub created_at: String,
    pub from: String,
    pub to: String,
    pub moments: Vec<DraftMoment>,
    pub snapshots: Vec<Snapshot>,
    pub brief: Brief,
    pub found: Found,
    /// Names spotted in the content, for "hide all names".
    pub names: Vec<String>,
}

fn clean(text: &str, max: usize, found: &mut Found) -> String {
    let (t, f) = redact::redact(&text.chars().take(max).collect::<String>());
    redact::merge(found, &f);
    t
}

/// A moment with every text field redacted.
pub fn redact_moment(m: &Moment, found: &mut Found) -> Moment {
    Moment {
        window: clean(&m.window, 200, found),
        question: m.question.as_deref().map(|q| clean(q, FIELD, found)),
        explanation: m.explanation.as_deref().map(|e| clean(e, 2000, found)),
        ocr: clean(&m.ocr, 2000, found),
        url: m.url.as_deref().map(|u| clean(u, 2000, found)),
        ..m.clone()
    }
}

/// A snapshot with every text field redacted (URLs lose secret parameters; terminal lines and
/// diff stats are cleaned line by line).
pub fn redact_snapshot(s: &Snapshot, found: &mut Found) -> Snapshot {
    let mut out = Snapshot {
        window: clean(&s.window, 200, found),
        document: s.document.as_deref().map(|d| clean(d, 200, found)),
        selection: s.selection.as_deref().map(|d| clean(d, 200, found)),
        url: s
            .url
            .as_deref()
            .map(|u| clean(&redact::strip_secret_params(u), 2000, found)),
        terminal: s.terminal.iter().map(|l| clean(l, 400, found)).collect(),
        path: s.path.as_deref().map(|p| clean(p, 400, found)),
        ..s.clone()
    };
    if let Some(git) = &mut out.git {
        git.last_commit = clean(&git.last_commit, 300, found);
        git.diff_stat = git.diff_stat.iter().map(|l| clean(l, 300, found)).collect();
    }
    out
}

/// "Hide all names": the names spotted go from every text of the draft.
pub fn hide_names(draft: &mut Draft) {
    let names = std::mem::take(&mut draft.names);
    if names.is_empty() {
        return;
    }
    *draft.found.entry(Kind::PersonName).or_insert(0) += names.len() as u32;
    let hide = |t: &str| redact::hide_names(t, &names);
    let v = draft.brief.to_json().to_string();
    if let Ok(b) = serde_json::from_str::<Value>(&hide(&v)) {
        if let Some((brief, _)) = Brief::checked(&b, &ids(draft)) {
            draft.brief = brief;
        }
    }
    for m in &mut draft.moments {
        m.moment.question = m.moment.question.as_deref().map(hide);
        m.moment.explanation = m.moment.explanation.as_deref().map(hide);
        m.moment.window = hide(&m.moment.window);
    }
    for s in &mut draft.snapshots {
        s.window = hide(&s.window);
    }
}

fn ids(draft: &Draft) -> Vec<String> {
    draft.moments.iter().map(|m| m.id.clone()).collect()
}

/// The moments' words and marks' colours for the brief (no pictures here; up to four crops go
/// beside it), and the included crops' ids.
pub fn brief_request(draft: &Draft, crops: &[(String, String)]) -> Value {
    let moments: Vec<Value> = draft
        .moments
        .iter()
        .filter(|m| m.include)
        .map(|m| {
            json!({
                "id": m.id, "at": iso(m.moment.at), "app": m.moment.app, "window": m.moment.window,
                "question": m.moment.question, "explanation": m.moment.explanation,
            })
        })
        .map(strip_nulls)
        .collect();
    json!({
        "senderName": draft.sender_name,
        "snapshots": draft.snapshots.iter().map(snapshot_json).collect::<Vec<_>>(),
        "moments": moments,
        "inkLabels": {},
        "crops": crops.iter().map(|(id, jpeg)| json!({ "momentId": id, "jpeg": jpeg })).collect::<Vec<_>>(),
    })
}

fn strip_nulls(mut v: Value) -> Value {
    if let Some(obj) = v.as_object_mut() {
        obj.retain(|_, x| !x.is_null());
    }
    v
}

pub fn iso(unix: i64) -> String {
    chrono_like(unix)
}

/// RFC 3339 (UTC) from Unix seconds, without a date crate.
fn chrono_like(unix: i64) -> String {
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

fn snapshot_json(s: &Snapshot) -> Value {
    let mut v = json!({
        "at": iso(s.at), "app": s.app, "window": s.window, "document": s.document,
        "selection": s.selection, "url": s.url,
        "terminal": if s.terminal.is_empty() { Value::Null } else { json!(s.terminal) },
    });
    if let Some(g) = &s.git {
        v["git"] = json!({
            "repo": g.repo, "branch": g.branch, "lastCommit": g.last_commit,
            "changedFiles": g.changed_files, "diffStat": g.diff_stat,
        });
    }
    strip_nulls(v)
}

/// The package's plaintext (`HandoffPlaintext`): the manifest and its crops.
pub fn plaintext(draft: &Draft) -> Vec<u8> {
    let included: Vec<&DraftMoment> = draft.moments.iter().filter(|m| m.include).collect();
    let mut files = BTreeMap::new();
    let moments: Vec<Value> = included
        .iter()
        .map(|m| {
            let crop = format!("{}.jpg", m.id);
            files.insert(crop.clone(), crate::screen::base64::encode(&m.crop));
            strip_nulls(json!({
                "id": m.id, "at": iso(m.moment.at), "app": m.moment.app, "window": m.moment.window,
                "crop": crop, "width": m.moment.width, "height": m.moment.height,
                "question": m.moment.question, "explanation": m.moment.explanation,
                "ink": m.moment.ink.iter().map(|s| json!({ "color": s.color, "width": s.width, "points": s.points })).collect::<Vec<_>>(),
            }))
        })
        .collect();
    let redactions: Vec<Value> = draft
        .found
        .iter()
        .flat_map(|(k, n)| std::iter::repeat_n(json!({ "kind": k }), (*n).min(50) as usize))
        .take(500)
        .collect();
    let manifest = json!({
        "version": 1,
        "createdAt": draft.created_at,
        "sender": { "name": draft.sender_name },
        "language": draft.language,
        "window": { "from": draft.from, "to": draft.to },
        "brief": draft.brief.to_json(),
        "moments": moments,
        "context": draft.snapshots.iter().map(snapshot_json).collect::<Vec<_>>(),
        "redactions": redactions,
    });
    json!({ "manifest": manifest, "files": files })
        .to_string()
        .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn moment(q: &str) -> Moment {
        Moment {
            at: 1_764_000_000,
            app: "code.exe".into(),
            window: "signup.ts - neb".into(),
            jpeg: String::new(),
            width: 10,
            height: 10,
            question: Some(q.into()),
            explanation: None,
            ink: vec![],
            ocr: String::new(),
            url: None,
        }
    }

    #[test]
    fn nothing_secret_reaches_the_package() {
        // Fake secrets built at run time, so no scanner sees one in the source.
        let key = ["sk-pr", "oj-AbC123", "dEf456GhI7", "89jKl012"].concat();
        let jwt = ["eyJhbGciOiJ", "IUzI1NiJ9.eyJzdWI", "iOiIxIn0.abcdefghij"].concat();
        let password = ["Tr0ub", "4dor&3"].concat();
        let mut found = Found::new();
        let m = redact_moment(
            &moment(&format!("why does {key} fail for bob@example.com?")),
            &mut found,
        );
        let s = redact_snapshot(
            &Snapshot {
                url: Some("https://app.example.com/reset?token=abc123XYZ&page=2".into()),
                terminal: vec![format!(
                    "export API_KEY={}",
                    ["hunter2", "hunter2"].concat()
                )],
                ..Snapshot::default()
            },
            &mut found,
        );
        let brief_in = json!({
            "title": "Fix login", "where": "4242 4242 4242 4242", "goal": "", "tried": [],
            "blockers": [{ "text": format!("password: {password}"), "momentId": "m1" }],
            "next": [{ "text": "Run it", "kind": "command", "target": format!("curl -H 'Authorization: Bearer {jwt}'") }],
            "openQuestions": []
        });
        let (brief, f) = Brief::checked(&brief_in, &["m1".into()]).unwrap();
        redact::merge(&mut found, &f);
        let draft = Draft {
            sender_name: "Faraz".into(),
            language: "en".into(),
            created_at: iso(1_764_000_000),
            from: iso(1_763_990_000),
            to: iso(1_764_000_000),
            moments: vec![DraftMoment {
                id: "m1".into(),
                include: true,
                moment: m,
                crop: vec![1, 2, 3],
            }],
            snapshots: vec![s],
            brief,
            found,
            names: vec![],
        };
        let text = String::from_utf8(plaintext(&draft)).unwrap();
        for secret in [
            key.as_str(),
            "bob@example.com",
            "abc123XYZ",
            "hunter2",
            "4242 4242",
            password.as_str(),
            jwt.as_str(),
        ] {
            assert!(!text.contains(secret), "{secret} leaked");
        }
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["manifest"]["moments"][0]["crop"], "m1.jpg");
        assert!(v["files"]["m1.jpg"].is_string());
        assert_eq!(v["manifest"]["brief"]["where"], "[hidden card]");
        assert!(!v["manifest"]["redactions"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_brief_cites_only_real_moments_and_keeps_known_kinds() {
        let v = json!({
            "title": "", "where": "", "goal": "", "tried": [{ "text": "x", "momentId": "m9" }], "blockers": [],
            "next": [{ "text": "rm it", "kind": "execute" }, { "text": "open it", "kind": "open" }], "openQuestions": []
        });
        let (b, _) = Brief::checked(&v, &["m1".into()]).unwrap();
        assert_eq!(b.title, "Handoff");
        assert_eq!(b.tried[0].moment_id, None);
        assert_eq!(b.next.len(), 1);
        assert!(Brief::checked(&json!({ "title": 5 }), &[]).is_none());
    }

    #[test]
    fn dates_are_rfc3339() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_764_000_000), "2025-11-24T16:00:00.000Z");
    }
}
