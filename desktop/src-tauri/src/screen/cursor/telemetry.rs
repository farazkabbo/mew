//! The cursor modes' telemetry (docs/CURSOR_MODES.md): counts only, kept on this computer
//! (`cursor-counts.json`) and shown on the settings page. Never a name, a path, a position or
//! anything else from the screen: the keys are a fixed list.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const COUNTS_FILE: &str = "cursor-counts.json";

/// Every key a count may have.
pub const KEYS: &[&str] = &[
    "show_me_started",
    "show_me_completed",
    "show_me_correction",
    "do_it_done",
    "do_it_undone",
    "catch_shown",
    "catch_continued",
    "catch_not_a_mistake",
    "catch_snoozed",
];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Counts(pub BTreeMap<String, u64>);

impl Counts {
    pub fn parse(text: &str) -> Counts {
        let mut counts: Counts = serde_json::from_str(text).unwrap_or_default();
        counts.0.retain(|k, _| KEYS.contains(&k.as_str()));
        counts
    }

    /// Adds one; unknown keys are ignored (so nothing else can ever be counted).
    pub fn add(&mut self, key: &str) {
        if KEYS.contains(&key) {
            *self.0.entry(key.to_owned()).or_insert(0) += 1;
        }
    }

    pub fn get(&self, key: &str) -> u64 {
        self.0.get(key).copied().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_counts_are_kept() {
        let mut c = Counts::parse(r#"{"do_it_done":2,"lease.pdf":1}"#);
        assert_eq!(c.get("do_it_done"), 2);
        assert_eq!(c.0.len(), 1);
        c.add("do_it_done");
        c.add("C:\\Users\\me\\secret.txt");
        assert_eq!(c.get("do_it_done"), 3);
        assert_eq!(c.0.len(), 1);
        assert_eq!(Counts::parse("broken"), Counts::default());
    }
}
