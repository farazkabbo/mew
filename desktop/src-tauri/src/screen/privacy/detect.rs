//! Finds sensitive text in a line of OCR output, so it can be covered before upload (brief §7.3).
//!
//! Each detector returns byte ranges of the line. Detection is deliberately generous: covering a
//! harmless word costs little, missing a card number or key costs a lot.

use std::ops::Range;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

/// Which kinds of text to cover. Cards, secrets and codes are on by default; emails and phone
/// numbers are opt-in (they're often what the user is asking about).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase", default)]
pub struct RedactionRules {
    pub cards: bool,
    pub secrets: bool,
    pub codes: bool,
    pub emails: bool,
    pub phones: bool,
}

impl Default for RedactionRules {
    fn default() -> Self {
        Self {
            cards: true,
            secrets: true,
            codes: true,
            emails: false,
            phones: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sensitive {
    Card,
    Secret,
    Code,
    Email,
    Phone,
}

/// Every sensitive range in `line` the rules ask for.
///
/// OCR often confuses look-alike characters (`1`/`l`/`I`, `0`/`O`, `5`/`S`), so number
/// detectors also run on a copy of the line with those fixed in number-like words. The copy
/// keeps every byte where it was, so its ranges apply to the original line.
pub fn find_sensitive(line: &str, rules: &RedactionRules) -> Vec<(Range<usize>, Sensitive)> {
    let numbers = with_digit_lookalikes_fixed(line);
    let mut found = Vec::new();
    if rules.cards {
        found.extend(card_numbers(&numbers).map(|range| (range, Sensitive::Card)));
    }
    if rules.secrets {
        found.extend(secrets(line).map(|range| (range, Sensitive::Secret)));
    }
    if rules.codes {
        found.extend(one_time_codes(&numbers).map(|range| (range, Sensitive::Code)));
    }
    if rules.emails {
        found.extend(
            patterns()
                .email
                .find_iter(line)
                .map(|m| (m.range(), Sensitive::Email)),
        );
    }
    if rules.phones {
        found.extend(phone_numbers(&numbers).map(|range| (range, Sensitive::Phone)));
    }
    found
}

/// Replaces characters OCR mistakes for digits, in words that are mostly digits already
/// ("4l11" → "4111", "S5O0" → "5500"). Only ASCII is swapped for ASCII, so byte offsets match
/// the original line exactly.
pub fn with_digit_lookalikes_fixed(line: &str) -> String {
    let lookalike = |c: char| match c {
        'l' | 'I' | '|' | 'i' => Some('1'),
        'O' | 'o' | 'D' => Some('0'),
        'S' | 's' => Some('5'),
        'B' => Some('8'),
        'Z' | 'z' => Some('2'),
        _ => None,
    };
    let mut out = String::with_capacity(line.len());
    for word in line.split_inclusive(' ') {
        let digits = word.chars().filter(char::is_ascii_digit).count();
        let similar = word.chars().filter(|&c| lookalike(c).is_some()).count();
        let letters = word.chars().filter(|c| c.is_alphabetic()).count();
        // At least half real digits, and every letter a look-alike: "4l11" yes, "list" no.
        let number_like = digits > 0 && digits * 2 >= digits + similar && letters == similar;
        if number_like {
            out.extend(word.chars().map(|c| lookalike(c).unwrap_or(c)));
        } else {
            out.push_str(word);
        }
    }
    out
}

struct Patterns {
    card: Regex,
    secrets: Vec<Regex>,
    long_token: Regex,
    code_context: Regex,
    code: Regex,
    email: Regex,
    phone: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        // The patterns are constants; a typo is caught by the tests, so `expect` can't fire at run time.
        let re = |pattern: &str| Regex::new(pattern).expect("valid built-in pattern");
        Patterns {
            // 13–19 digits, optionally grouped with spaces or dashes.
            card: re(r"\b\d(?:[ -]?\d){12,18}\b"),
            secrets: [
                // AWS access key id. Case-tolerant: OCR reads "I" as "l" (seen in testing).
                r"\bA[KS][I1l|]A[0-9A-Za-z|]{16}\b",
                r"\bgh[pousr]_[A-Za-z0-9]{30,}\b",                       // GitHub tokens
                r"\bgithub_pat_[A-Za-z0-9_]{22,}\b",                     // GitHub fine-grained token
                r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}",              // Anthropic / OpenAI keys
                r"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b",      // Stripe keys
                r"\bAIza[0-9A-Za-z_\-]{35}\b",                           // Google API key
                r"\bxox[abprs]-[A-Za-z0-9\-]{10,}",                      // Slack tokens
                r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}", // JWTs
                r"-----BEGIN [A-Z ]*PRIVATE KEY-----",                   // PEM private keys
                r"(?i)\b(?:api[_ -]?key|secret|token|passwo?r?d|pwd)\s*[:=]\s*\S{6,}", // key=value
            ]
            .iter()
            .map(|pattern| re(pattern))
            .collect(),
            long_token: re(r"[A-Za-z0-9+/_=\-]{32,}"),
            code_context: re(r"(?i)\b(?:code|otp|one[- ]time|verification|verify|passcode|2fa|mfa|security|pin|login|sign[- ]in)\b"),
            code: re(r"\b\d{3}[ -]?\d{3}\b|\b\d{4,8}\b"),
            email: re(r"(?i)\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b"),
            phone: re(r"\+?\(?\d[\d ().\-]{6,}\d"),
        }
    })
}

/// Card-like digit runs that pass the Luhn checksum (so order numbers mostly don't match).
fn card_numbers(line: &str) -> impl Iterator<Item = Range<usize>> + '_ {
    patterns()
        .card
        .find_iter(line)
        .filter(|m| luhn_valid(m.as_str()))
        .map(|m| m.range())
}

/// Known key formats, plus long random-looking tokens.
fn secrets(line: &str) -> impl Iterator<Item = Range<usize>> + '_ {
    let known = patterns()
        .secrets
        .iter()
        .flat_map(move |re| re.find_iter(line).map(|m| m.range()));
    let random = patterns()
        .long_token
        .find_iter(line)
        .filter(|m| looks_random(m.as_str()))
        .map(|m| m.range());
    known.chain(random)
}

/// Short numbers on a line that talks about codes, PINs or signing in.
fn one_time_codes(line: &str) -> Box<dyn Iterator<Item = Range<usize>> + '_> {
    if patterns().code_context.is_match(line) {
        Box::new(patterns().code.find_iter(line).map(|m| m.range()))
    } else {
        Box::new(std::iter::empty())
    }
}

fn phone_numbers(line: &str) -> impl Iterator<Item = Range<usize>> + '_ {
    patterns()
        .phone
        .find_iter(line)
        .filter(|m| (7..=15).contains(&digit_count(m.as_str())))
        .map(|m| m.range())
}

/// The Luhn checksum used by payment card numbers (13–19 digits).
pub fn luhn_valid(text: &str) -> bool {
    let digits: Vec<u32> = text.chars().filter_map(|c| c.to_digit(10)).collect();
    if !(13..=19).contains(&digits.len()) {
        return false;
    }
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, &d)| {
            if i % 2 == 1 {
                if d * 2 > 9 {
                    d * 2 - 9
                } else {
                    d * 2
                }
            } else {
                d
            }
        })
        .sum();
    sum.is_multiple_of(10)
}

/// A long token mixing upper case, lower case and digits: what generated secrets look like,
/// and what ordinary words and paths don't.
fn looks_random(token: &str) -> bool {
    let upper = token.chars().filter(char::is_ascii_uppercase).count();
    let lower = token.chars().filter(char::is_ascii_lowercase).count();
    let digits = token.chars().filter(char::is_ascii_digit).count();
    upper >= 3 && lower >= 3 && digits >= 3
}

fn digit_count(text: &str) -> usize {
    text.chars().filter(char::is_ascii_digit).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(line: &str, rules: &RedactionRules) -> Vec<(String, Sensitive)> {
        find_sensitive(line, rules)
            .into_iter()
            .map(|(range, kind)| (line[range].to_owned(), kind))
            .collect()
    }

    fn all() -> RedactionRules {
        RedactionRules {
            cards: true,
            secrets: true,
            codes: true,
            emails: true,
            phones: true,
        }
    }

    #[test]
    fn luhn() {
        assert!(luhn_valid("4111 1111 1111 1111"));
        assert!(luhn_valid("5555-5555-5555-4444"));
        assert!(luhn_valid("378282246310005")); // Amex test number, 15 digits
        assert!(!luhn_valid("4111 1111 1111 1112"));
        assert!(!luhn_valid("1234"));
    }

    #[test]
    fn fixes_ocr_lookalikes_only_in_number_like_words() {
        assert_eq!(
            with_digit_lookalikes_fixed("Card 4242 424Z 4Z4Z 4242"),
            "Card 4242 4242 4242 4242"
        );
        assert_eq!(
            with_digit_lookalikes_fixed("code is 48Z9l3"),
            "code is 482913"
        );
        // Ordinary words keep their letters, even ones made of look-alikes.
        assert_eq!(
            with_digit_lookalikes_fixed("Solid list Is 2FA"),
            "Solid list Is 2FA"
        );
        // Byte offsets are unchanged, so ranges found in the copy fit the original.
        let line = "x 4l11 é";
        assert_eq!(with_digit_lookalikes_fixed(line).len(), line.len());
    }

    #[test]
    fn finds_numbers_and_keys_that_ocr_misread() {
        let rules = RedactionRules::default();
        // As Windows OCR actually read them in testing: "I" became "l".
        assert_eq!(
            kinds("AWS key AKIAlOSFODNN7EXAMPLE", &rules),
            vec![("AKIAlOSFODNN7EXAMPLE".into(), Sensitive::Secret)]
        );
        assert_eq!(
            kinds("Card 4242 4242 4Z42 4242", &rules),
            vec![("4242 4242 4Z42 4242".into(), Sensitive::Card)]
        );
        assert_eq!(
            kinds("Your code is 48Z913", &rules),
            vec![("48Z913".into(), Sensitive::Code)]
        );
    }

    #[test]
    fn finds_card_numbers_but_not_other_long_numbers() {
        let rules = RedactionRules::default();
        assert_eq!(
            kinds("Card: 4111 1111 1111 1111 exp 12/29", &rules),
            vec![("4111 1111 1111 1111".into(), Sensitive::Card)]
        );
        assert_eq!(kinds("4111111111111111", &rules)[0].1, Sensitive::Card);
        assert!(kinds("Order 4111 1111 1111 1112 shipped", &rules).is_empty());
    }

    #[test]
    fn finds_keys_and_tokens() {
        let rules = RedactionRules::default();
        for (line, secret) in [
            (
                "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
                "AKIAIOSFODNN7EXAMPLE",
            ),
            (
                "token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
                "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
            ),
            (
                "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
                "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
            ),
            (
                "const key = 'AIzaSyD-1234567890abcdefghijklmnopqrstu'",
                "AIzaSyD-1234567890abcdefghijklmnopqrstu",
            ),
            (
                "-----BEGIN RSA PRIVATE KEY-----",
                "-----BEGIN RSA PRIVATE KEY-----",
            ),
        ] {
            let found = kinds(line, &rules);
            assert!(
                found
                    .iter()
                    .any(|(text, kind)| *kind == Sensitive::Secret && text.contains(secret)),
                "{line}: {found:?}"
            );
        }
        // A random-looking token with no known prefix.
        assert!(!kinds("session: Zx9Qw3Er7Ty1Ui5Op8As2Df6Gh4Jk0Lm", &rules).is_empty());
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        let rules = RedactionRules::default();
        for line in [
            "Insert > PivotTable > From Table/Range",
            "C:/Users/Documents/Projects/really-long-folder-name-here",
            "The quick brown fox jumps over the lazy dog 2024",
            "Total: 1,234.56 USD",
        ] {
            assert!(
                kinds(line, &rules).is_empty(),
                "{line}: {:?}",
                kinds(line, &rules)
            );
        }
    }

    #[test]
    fn finds_codes_only_in_context() {
        let rules = RedactionRules::default();
        assert_eq!(
            kinds("Your verification code is 482913", &rules),
            vec![("482913".into(), Sensitive::Code)]
        );
        assert_eq!(kinds("Security code: 123 456", &rules)[0].0, "123 456");
        assert!(kinds("Page 482913 of the report", &rules).is_empty());
    }

    #[test]
    fn emails_and_phones_are_opt_in() {
        let line = "Contact jo@example.com or +1 (555) 010-9999";
        assert!(kinds(line, &RedactionRules::default()).is_empty());
        let found = kinds(line, &all());
        assert!(found.contains(&("jo@example.com".into(), Sensitive::Email)));
        assert!(found
            .iter()
            .any(|(text, kind)| *kind == Sensitive::Phone && text.contains("555")));
    }

    #[test]
    fn nothing_when_everything_is_off() {
        let none = RedactionRules {
            cards: false,
            secrets: false,
            codes: false,
            emails: false,
            phones: false,
        };
        assert!(kinds(
            "4111 1111 1111 1111 AKIAIOSFODNN7EXAMPLE code 123456",
            &none
        )
        .is_empty());
    }
}
