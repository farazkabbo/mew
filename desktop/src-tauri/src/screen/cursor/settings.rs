//! The cursor modes' settings (docs/CURSOR_MODES.md, I), kept in `screen-coach.json` with the
//! rest of Screen Coach's settings: on this computer only, edited only by the bundled settings
//! page (SCREEN_COACH decision 1).
//!
//! CATCH ME has its own short explanation and its own consent (`catch_me_consent`): turning it on
//! means reading, on this computer, the names of buttons near the cursor, email drafts' words and
//! the terminal line being typed. It's off until the student reads that and turns it on.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::posterior::TriggerParams;

/// Bumped when CATCH ME's explanation changes in substance.
pub const CATCH_ME_CONSENT: u32 = 1;

/// How much SHOW ME shows (the settings page's "guidance level").
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Guidance {
    /// Fades with practice: full path, then next target only, then corrections only, then silent.
    #[default]
    Auto,
    Full,
    Light,
    CorrectionsOnly,
}

/// CATCH ME's rules, by id.
pub const RULES: [&str; 5] = ["reply_all", "attachment", "unsaved", "delete", "terminal"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase", default)]
pub struct CursorSettings {
    /// CATCH ME is on (only counts with the current consent).
    pub catch_me: bool,
    pub catch_me_consent: u32,
    /// Rules turned off (absent: on).
    pub rules_off: Vec<String>,
    /// Snoozed rules and when the snooze ends (Unix seconds).
    pub snoozed: BTreeMap<String, u64>,
    /// "Not a mistake" counts per rule and app ("reply_all|outlook.exe"): each makes that rule
    /// less eager in that app.
    pub not_mistakes: BTreeMap<String, u32>,
    /// Say corrections out loud ("below", "left").
    pub voice: bool,
    pub guidance: Guidance,
    /// Developer view: the predicted endpoint, σ and target probabilities, live.
    pub debug: bool,
    /// Developer: keep mouse traces of clicked movements in a local folder (positions and the
    /// clicked control's rectangle only), for tuning the predictor.
    pub record_traces: bool,
    /// The predictor's and trigger's thresholds (defaults when absent).
    pub tuning: Option<TriggerParams>,
}

impl Default for CursorSettings {
    fn default() -> Self {
        Self {
            catch_me: false,
            catch_me_consent: 0,
            rules_off: Vec::new(),
            snoozed: BTreeMap::new(),
            not_mistakes: BTreeMap::new(),
            voice: true,
            guidance: Guidance::Auto,
            debug: false,
            record_traces: false,
            tuning: None,
        }
    }
}

impl CursorSettings {
    pub fn catch_me_on(&self) -> bool {
        self.catch_me && self.catch_me_consent >= CATCH_ME_CONSENT
    }

    pub fn rule_on(&self, rule: &str, now_s: u64) -> bool {
        !self.rules_off.iter().any(|r| r == rule)
            && self.snoozed.get(rule).is_none_or(|&until| now_s >= until)
    }

    pub fn tuning(&self) -> TriggerParams {
        self.tuning.unwrap_or_default()
    }

    /// Checks settings from the page: known rule ids only, sane thresholds.
    pub fn normalized(mut self) -> Result<Self, String> {
        self.rules_off.retain(|r| RULES.contains(&r.as_str()));
        self.rules_off.sort();
        self.rules_off.dedup();
        self.snoozed.retain(|r, _| RULES.contains(&r.as_str()));
        self.not_mistakes
            .retain(|k, _| k.split_once('|').is_some_and(|(r, _)| RULES.contains(&r)));
        if let Some(t) = &self.tuning {
            t.check()?;
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catch_me_needs_its_own_consent() {
        let mut s = CursorSettings::default();
        assert!(!s.catch_me_on());
        s.catch_me = true;
        assert!(!s.catch_me_on());
        s.catch_me_consent = CATCH_ME_CONSENT;
        assert!(s.catch_me_on());
    }

    #[test]
    fn a_snooze_ends() {
        let mut s = CursorSettings::default();
        s.snoozed.insert("reply_all".into(), 1000);
        assert!(!s.rule_on("reply_all", 999));
        assert!(s.rule_on("reply_all", 1000));
        s.rules_off.push("terminal".into());
        assert!(!s.rule_on("terminal", 0));
    }

    #[test]
    fn unknown_rules_are_dropped() {
        let s = CursorSettings {
            rules_off: vec!["nope".into(), "delete".into(), "delete".into()],
            not_mistakes: [
                ("x|a.exe".to_owned(), 1),
                ("unsaved|code.exe".to_owned(), 2),
            ]
            .into_iter()
            .collect(),
            ..CursorSettings::default()
        }
        .normalized()
        .unwrap();
        assert_eq!(s.rules_off, vec!["delete"]);
        assert_eq!(s.not_mistakes.len(), 1);
    }
}
