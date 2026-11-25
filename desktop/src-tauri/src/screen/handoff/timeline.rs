//! The session timeline (docs/HANDOFF_FEATURE.md §3): an append-only, local-only log of the
//! moments the student saved and context snapshots (the app in front, its document or page, git
//! state), kept for 24 hours in the app's local data folder, each record encrypted for this user
//! on this computer (DPAPI, `win/dpapi.rs`). It never leaves the computer except as part of a
//! package the sender approved. Blocked apps and private windows never get in (the caller checks
//! the same exclusion list as Screen Coach). Turned on in Screen Coach settings (off by default).

use serde::{Deserialize, Serialize};

/// How long a record is kept.
pub const KEEP_S: i64 = 24 * 3600;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ink {
    pub color: String,
    pub width: f32,
    /// [x, y, pressure, t] in the crop's pixels.
    pub points: Vec<[f32; 4]>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Moment {
    /// Unix seconds.
    pub at: i64,
    pub app: String,
    pub window: String,
    /// The saved crop (JPEG), base64.
    pub jpeg: String,
    pub width: u32,
    pub height: u32,
    pub question: Option<String>,
    pub explanation: Option<String>,
    pub ink: Vec<Ink>,
    /// Text read on the device from the (already redacted) crop: for key-moment scoring.
    pub ocr: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Git {
    pub repo: String,
    pub branch: String,
    pub last_commit: String,
    pub changed_files: u32,
    pub diff_stat: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub at: i64,
    pub app: String,
    pub window: String,
    pub document: Option<String>,
    pub selection: Option<String>,
    pub url: Option<String>,
    pub git: Option<Git>,
    /// The last terminal lines (commands), when readable.
    pub terminal: Vec<String>,
    /// An absolute path seen in the window (a file the student had open), if any.
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Moment(Moment),
    Snapshot(Snapshot),
}

impl Event {
    pub fn at(&self) -> i64 {
        match self {
            Event::Moment(m) => m.at,
            Event::Snapshot(s) => s.at,
        }
    }
}

/// The records still inside the 24 hours, oldest first.
pub fn keep_recent(mut events: Vec<Event>, now: i64) -> Vec<Event> {
    events.retain(|e| now - e.at() < KEEP_S && e.at() <= now + 60);
    events.sort_by_key(Event::at);
    events
}

/// Focus snapshots at most one every 20 seconds (a moment or the hand-off itself always takes one).
pub const SNAPSHOT_GAP_S: i64 = 20;

pub fn snapshot_due(last: Option<i64>, now: i64) -> bool {
    last.is_none_or(|t| now - t >= SNAPSHOT_GAP_S)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(at: i64) -> Event {
        Event::Snapshot(Snapshot {
            at,
            ..Snapshot::default()
        })
    }

    #[test]
    fn only_the_last_day_is_kept() {
        let now = 100_000;
        let kept = keep_recent(
            vec![snap(now - 10), snap(now - KEEP_S - 1), snap(now - 5_000)],
            now,
        );
        assert_eq!(
            kept.iter().map(Event::at).collect::<Vec<_>>(),
            vec![now - 5_000, now - 10]
        );
    }

    #[test]
    fn snapshots_are_debounced() {
        assert!(snapshot_due(None, 0));
        assert!(!snapshot_due(Some(100), 110));
        assert!(snapshot_due(Some(100), 120));
    }

    #[test]
    fn a_record_round_trips() {
        let e = snap(5);
        let text = serde_json::to_string(&e).unwrap();
        assert!(text.contains(r#""kind":"snapshot""#));
        assert_eq!(serde_json::from_str::<Event>(&text).unwrap(), e);
    }
}
