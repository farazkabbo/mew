//! Handoff on the desktop (docs/HANDOFF_FEATURE.md, being built). Pure parts here (tested on any
//! OS); what touches Windows is in `win/` (DPAPI, AES-GCM, git, blur) and `handoff_run.rs`.
//!
//! - `timeline`: the local, encrypted 24-hour session timeline (moments and context snapshots).
//! - `select`: the session window and the key moments.
//! - `context`: git and paths, read-only.
//! - `redact`: secrets and personal information, before anything is shown or sent.
//! - `package`: the manifest and files the preview shows and the sender sends.
//! - `pickup`: what "Pick up from here" may do, and nothing else.

pub mod context;
pub mod package;
pub mod pickup;
pub mod redact;
pub mod select;
pub mod settings;
pub mod timeline;

/// "Hand this off to Rahbir", "hand off to Rahbir", "hand this off": the request, with the name
/// said (if any) to put in the recipient field. None for anything else.
pub fn hand_off_phrase(said: &str) -> Option<Option<String>> {
    let lower = said.trim().trim_end_matches(['.', '!', '?']).to_lowercase();
    let lower = lower
        .trim_start_matches("hey ")
        .trim_start_matches("neb ")
        .trim_start_matches("neb, ")
        .trim_start_matches("please ")
        .trim_start_matches("can you ")
        .trim();
    let rest = [
        "hand this off",
        "hand it off",
        "hand off",
        "hand this over",
        "hand it over",
    ]
    .iter()
    .find_map(|p| lower.strip_prefix(p))?;
    let rest = rest.trim();
    if rest.is_empty() {
        return Some(None);
    }
    let name = rest.strip_prefix("to ")?.trim();
    let name: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || " .'-@".contains(*c))
        .take(60)
        .collect();
    Some((!name.is_empty()).then(|| {
        let mut chars = name.chars();
        chars
            .next()
            .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
            .unwrap_or_default()
    }))
}

#[cfg(test)]
mod phrase_tests {
    use super::hand_off_phrase;

    #[test]
    fn hears_a_hand_off() {
        assert_eq!(
            hand_off_phrase("Hand this off to Rahbir."),
            Some(Some("Rahbir".into()))
        );
        assert_eq!(
            hand_off_phrase("neb, hand off to priya"),
            Some(Some("Priya".into()))
        );
        assert_eq!(hand_off_phrase("hand this off"), Some(None));
        assert_eq!(hand_off_phrase("how do I hand off a project?"), None);
        assert_eq!(hand_off_phrase("handoff"), None);
        assert_eq!(hand_off_phrase("hand this offline"), None);
    }
}
