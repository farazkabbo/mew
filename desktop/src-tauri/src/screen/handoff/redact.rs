//! Handoff's redaction on the sender's computer (docs/HANDOFF_FEATURE.md §7): every text field,
//! URL, terminal line and diff line is cleaned before the preview, with the same detectors as
//! `packages/shared/src/handoff.ts` (both are tested on `handoff-redaction.cases.json`). Pictures
//! are covered separately: OCR'd text boxes are blurred (`win/handoff_blur.rs`).
//!
//! What's returned is the cleaned text and the kinds found with their counts: never the values.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::{Captures, Regex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Email,
    Phone,
    Secret,
    Card,
    PersonName,
    Address,
    Custom,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Kind::Email => "[hidden email]",
            Kind::Phone => "[hidden phone]",
            Kind::Secret => "[hidden secret]",
            Kind::Card => "[hidden card]",
            Kind::PersonName => "[hidden name]",
            Kind::Address => "[hidden address]",
            Kind::Custom => "[hidden]",
        }
    }
}

pub type Found = BTreeMap<Kind, u32>;

struct Rules {
    url: Regex,
    param: Regex,
    secret_name: Regex,
    plain: Vec<(Kind, Regex)>,
    env_line: Regex,
    password: Regex,
    card: Regex,
    phone: Regex,
    token: Regex,
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        let re = |p: &str| Regex::new(p).expect("valid");
        Rules {
            url: re(r#"https?://[^\s"'<>]+"#),
            param: re(r"([?&])([^=&#\s]+)=([^&#\s]*)"),
            secret_name: re(
                r"(?i)^(?:token|access_token|refresh_token|id_token|key|api_key|apikey|code|sig|signature|session|sessionid|auth|password|pass|secret|client_secret)$",
            ),
            plain: vec![
                (
                    Kind::Secret,
                    re(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
                ),
                (Kind::Secret, re(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}")),
                (Kind::Secret, re(r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}")),
                (Kind::Secret, re(r"\bgh[pousr]_[A-Za-z0-9]{20,}")),
                (Kind::Secret, re(r"\bxox[abposr]-[A-Za-z0-9-]{10,}")),
                (Kind::Secret, re(r"\bAKIA[0-9A-Z]{16}\b")),
            ],
            env_line: re(r"(?m)^(\s*(?:export\s+)?[A-Z][A-Z0-9_]{2,}\s*=\s*)(\S.*)$"),
            password: re(r"(?i)(\b(?:password|passwd|pwd|passcode)\b\s*[:=]\s*)(\S+)"),
            card: re(r"\b(?:\d[ -]?){12,18}\d\b"),
            phone: re(
                r"(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\b\d{3,5}[\s.-]\d{3,6}(?:[\s.-]\d{3,4})?\b",
            ),
            token: re(r"[A-Za-z0-9_+/=-]{24,}"),
        }
    })
}

fn email_and_address() -> &'static [(Kind, Regex)] {
    static RULES: OnceLock<Vec<(Kind, Regex)>> = OnceLock::new();
    RULES.get_or_init(|| {
        vec![
            (Kind::Email, Regex::new(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b").expect("valid")),
            (
                Kind::Address,
                Regex::new(r"\b\d{1,5}[A-Z]?\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Court|Ct|Place|Pl|Close|Crescent|Terrace)\b")
                    .expect("valid"),
            ),
        ]
    })
}

fn luhn(digits: &str) -> bool {
    let mut sum = 0;
    for (i, c) in digits.chars().rev().enumerate() {
        let mut d = c.to_digit(10).unwrap_or(0);
        if i % 2 == 1 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    sum % 10 == 0
}

fn entropy(s: &str) -> f64 {
    let mut counts: BTreeMap<char, f64> = BTreeMap::new();
    for c in s.chars() {
        *counts.entry(c).or_insert(0.0) += 1.0;
    }
    let n = s.chars().count() as f64;
    counts.values().map(|k| -(k / n) * (k / n).log2()).sum()
}

/// A URL with secret-looking query values replaced.
pub fn strip_secret_params(url: &str) -> String {
    let r = rules();
    r.param
        .replace_all(url, |c: &Captures| {
            if r.secret_name.is_match(&c[2]) {
                format!("{}{}=hidden", &c[1], &c[2])
            } else {
                c[0].to_owned()
            }
        })
        .into_owned()
}

/// The text with every detected secret and piece of personal information replaced, and what was
/// found (kinds and counts).
pub fn redact(input: &str) -> (String, Found) {
    let r = rules();
    let mut found = Found::new();
    let mut note = |k: Kind| *found.entry(k).or_insert(0) += 1;
    let mut text = r
        .url
        .replace_all(input, |c: &Captures| {
            let stripped = strip_secret_params(&c[0]);
            if stripped != c[0] {
                note(Kind::Secret);
            }
            stripped
        })
        .into_owned();
    for (kind, re) in &r.plain {
        text = re
            .replace_all(&text, |_: &Captures| {
                note(*kind);
                kind.label()
            })
            .into_owned();
    }
    text = r
        .env_line
        .replace_all(&text, |c: &Captures| {
            note(Kind::Secret);
            format!("{}[hidden secret]", &c[1])
        })
        .into_owned();
    text = r
        .password
        .replace_all(&text, |c: &Captures| {
            note(Kind::Secret);
            format!("{}[hidden secret]", &c[1])
        })
        .into_owned();
    for (kind, re) in email_and_address() {
        text = re
            .replace_all(&text, |_: &Captures| {
                note(*kind);
                kind.label()
            })
            .into_owned();
    }
    text = r
        .card
        .replace_all(&text, |c: &Captures| {
            let digits: String = c[0].chars().filter(char::is_ascii_digit).collect();
            if (13..=19).contains(&digits.len()) && luhn(&digits) {
                note(Kind::Card);
                Kind::Card.label().to_owned()
            } else {
                c[0].to_owned()
            }
        })
        .into_owned();
    text = r
        .phone
        .replace_all(&text, |c: &Captures| {
            if c[0].chars().filter(char::is_ascii_digit).count() >= 7 {
                note(Kind::Phone);
                Kind::Phone.label().to_owned()
            } else {
                c[0].to_owned()
            }
        })
        .into_owned();
    text = r
        .token
        .replace_all(&text, |c: &Captures| {
            let m = &c[0];
            let mixed = m.chars().any(|ch| ch.is_ascii_digit())
                && m.chars().any(|ch| ch.is_ascii_alphabetic());
            if mixed && entropy(m) >= 3.5 && !m.starts_with("[hidden") {
                note(Kind::Secret);
                Kind::Secret.label().to_owned()
            } else {
                m.to_owned()
            }
        })
        .into_owned();
    (text, found)
}

/// Words that look like people's names (two capitalised words, not the sender's or recipient's):
/// flagged in the preview with "hide all names", never hidden on their own.
pub fn possible_names(text: &str, known: &[&str]) -> Vec<String> {
    const NOT_NAMES: &[&str] = &[
        "Ask",
        "The",
        "This",
        "That",
        "Please",
        "Open",
        "Run",
        "Fix",
        "Add",
        "See",
        "Use",
        "Check",
        "Click",
        "When",
        "What",
        "Why",
        "How",
        "And",
        "But",
        "For",
        "From",
        "With",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
        "New",
        "Pull",
        "Merge",
        "Visual",
        "Studio",
        "Google",
        "Microsoft",
    ];
    let capital = |w: &str| {
        let mut c = w.chars();
        c.next().is_some_and(char::is_uppercase)
            && w.len() >= 2
            && w.len() <= 21
            && c.all(char::is_lowercase)
    };
    let words: Vec<&str> = text
        .split(|c: char| !c.is_alphabetic())
        .filter(|w| !w.is_empty())
        .collect();
    let mut out: Vec<String> = words
        .windows(2)
        .filter(|p| capital(p[0]) && capital(p[1]))
        .filter(|p| !NOT_NAMES.contains(&p[0]) && !NOT_NAMES.contains(&p[1]))
        .map(|p| format!("{} {}", p[0], p[1]))
        .filter(|n| text.contains(n.as_str()) && !known.iter().any(|k| n.contains(k)))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Hides the given names wherever they appear ("hide all names").
pub fn hide_names(text: &str, names: &[String]) -> String {
    let mut out = text.to_owned();
    for name in names {
        out = out.replace(name.as_str(), Kind::PersonName.label());
    }
    out
}

pub fn merge(into: &mut Found, more: &Found) {
    for (k, n) in more {
        *into.entry(*k).or_insert(0) += n;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stored in fragments (joined here), so no scanner sees a whole fake token.
    #[derive(serde::Deserialize)]
    struct Case {
        text: Vec<String>,
        hidden: Vec<String>,
        kept: String,
    }
    #[derive(serde::Deserialize)]
    struct Cases {
        cases: Vec<Case>,
        clean: Vec<String>,
    }

    fn cases() -> Cases {
        serde_json::from_str(include_str!(
            "../../../../../packages/shared/src/handoff-redaction.cases.json"
        ))
        .unwrap()
    }

    #[test]
    fn every_shared_case_is_hidden() {
        for case in cases().cases {
            let (text, hidden) = (case.text.concat(), case.hidden.concat());
            let (out, found) = redact(&text);
            assert!(!out.contains(&hidden), "{text:?} → {out:?}");
            if !case.kept.is_empty() {
                assert!(out.contains(&case.kept), "{text:?} → {out:?}");
            }
            assert!(!found.is_empty());
        }
    }

    #[test]
    fn ordinary_work_text_is_left_alone() {
        for text in cases().clean {
            let (out, found) = redact(&text);
            assert_eq!(out, text);
            assert!(found.is_empty(), "{text}: {found:?}");
        }
    }

    #[test]
    fn names_are_flagged_not_hidden() {
        let text = "Ask Priya Sharma about the Faraz Kabir branch";
        let names = possible_names(text, &["Faraz"]);
        assert_eq!(names, vec!["Priya Sharma"]);
        assert_eq!(redact(text).0, text);
        assert_eq!(
            hide_names(text, &names),
            "Ask [hidden name] about the Faraz Kabir branch"
        );
    }
}
