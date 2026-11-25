//! Handoff's settings (docs/HANDOFF_FEATURE.md §12), kept in `screen-coach.json` with Screen
//! Coach's: on this computer only (SCREEN_COACH decision 1).

use serde::{Deserialize, Serialize};

use super::select;

/// The settings Handoff keeps (in `screen-coach.json`, with Screen Coach's).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase", default)]
pub struct HandoffSettings {
    /// Keep the 24-hour session timeline (off until turned on).
    pub timeline: bool,
    /// The default session window, in minutes (30, 90 or 180).
    pub window_min: u32,
    pub expiry_days: u32,
    pub always_hide_names: bool,
    /// The name handoffs are signed with.
    pub sender_name: String,
    /// The last people handed off to (the recipient picker's suggestions).
    pub recent: Vec<String>,
}

impl Default for HandoffSettings {
    fn default() -> Self {
        Self {
            timeline: false,
            window_min: 90,
            expiry_days: 7,
            always_hide_names: false,
            sender_name: String::new(),
            recent: Vec::new(),
        }
    }
}

impl HandoffSettings {
    pub fn normalized(mut self) -> Self {
        if !select::WINDOWS_MIN.contains(&self.window_min) {
            self.window_min = 90;
        }
        if ![1, 7, 30].contains(&self.expiry_days) {
            self.expiry_days = 7;
        }
        self.sender_name = self
            .sender_name
            .trim()
            .chars()
            .filter(|c| !c.is_control())
            .take(80)
            .collect();
        self.recent.retain(|e| e.contains('@') && e.len() <= 254);
        self.recent.truncate(10);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_are_cleaned() {
        let s = HandoffSettings {
            window_min: 5,
            expiry_days: 3,
            recent: vec!["x".into(), "a@b.co".into()],
            ..HandoffSettings::default()
        }
        .normalized();
        assert_eq!((s.window_min, s.expiry_days), (90, 7));
        assert_eq!(s.recent, vec!["a@b.co"]);
        assert!(!HandoffSettings::default().timeline, "off until turned on");
    }
}
