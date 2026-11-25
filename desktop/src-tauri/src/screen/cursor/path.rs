//! SHOW ME's paths (E): ordered steps that name controls by meaning (control type, name,
//! automation id, window), never by position, resolved against what's on screen at each step.
//! So a path survives another resolution, scaling, theme, monitor and small app updates.
//!
//! Resolution order: the exact automation id (when the step knows one and it's still there),
//! then the exact name and control type, then the exact name, then a close name ("Colours" for
//! "Colors", "Personalisation" for "Personalization").
//!
//! Paths that worked are kept on this computer (`PathCache`, `cursor-paths.json`): the steps and
//! a practice count, keyed by the request and the app. A shared library later uses the same
//! step shape (docs/CURSOR_MODES.md); nothing is synced now.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::target::{Target, TargetSet};

/// One step: which control to click.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Anchor {
    pub control_type: String,
    pub name: String,
    /// Learned from a run that worked; may go stale (then the name decides).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub automation_id: String,
    /// The window's process when the step is in another app ("systemsettings.exe").
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub process: String,
}

/// Lowercase, accelerator ampersands and punctuation dropped, spaces collapsed.
pub fn normalise(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut space = false;
    for c in name.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
            space = false;
        } else if (c.is_whitespace() || matches!(c, '-' | '_' | '/')) && !space && !out.is_empty() {
            out.push(' ');
            space = true;
        }
    }
    out.trim_end().to_owned()
}

/// Similarity of two normalised names, 0..1 (1 - edit distance / longer length).
pub fn similarity(a: &str, b: &str) -> f64 {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let longest = a.len().max(b.len());
    if longest == 0 {
        return 1.0;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut row = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            row[j + 1] = (prev[j + 1] + 1).min(row[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut row);
    }
    1.0 - prev[b.len()] as f64 / longest as f64
}

/// How close a name must be to count.
pub const FUZZY_MIN: f64 = 0.8;

/// The target `anchor` names in `set`, if it's on screen.
pub fn resolve<'a>(anchor: &Anchor, set: &'a TargetSet) -> Option<&'a Target> {
    if !anchor.process.is_empty() && !set.process.is_empty() && anchor.process != set.process {
        return None;
    }
    if !anchor.automation_id.is_empty() {
        if let Some(t) = set.targets.iter().find(|t| {
            t.automation_id == anchor.automation_id && t.control_type == anchor.control_type
        }) {
            return Some(t);
        }
    }
    let wanted = normalise(&anchor.name);
    if wanted.is_empty() {
        return None;
    }
    let exact: Vec<&Target> = set
        .targets
        .iter()
        .filter(|t| normalise(&t.name) == wanted)
        .collect();
    if let Some(t) = exact.iter().find(|t| t.control_type == anchor.control_type) {
        return Some(t);
    }
    if let Some(t) = exact.first() {
        return Some(t);
    }
    set.targets
        .iter()
        .map(|t| {
            let s = similarity(&normalise(&t.name), &wanted)
                + if t.control_type == anchor.control_type {
                    0.05
                } else {
                    0.0
                };
            (t, s)
        })
        .filter(|(_, s)| *s >= FUZZY_MIN)
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(t, _)| t)
}

/// Words that don't change what's being asked ("how do I…", "please").
const LEAD_INS: &[&str] = &[
    "show me how to",
    "show me how do i",
    "show me how i",
    "show me where",
    "how do i",
    "how can i",
    "how to",
    "where do i",
    "where is",
    "wheres",
    "where can i",
    "help me",
];
const FILLER: &[&str] = &[
    "please", "neb", "the", "a", "my", "me", "for", "on", "in", "to",
];

/// The key a path is kept under: what was asked, without lead-ins and filler, and the app.
pub fn signature(goal: &str, process: &str) -> String {
    let mut g = normalise(goal);
    for lead in LEAD_INS {
        if let Some(rest) = g.strip_prefix(lead) {
            g = rest.trim().to_owned();
            break;
        }
    }
    let words: Vec<&str> = g
        .split(' ')
        .filter(|w| !w.is_empty() && !FILLER.contains(w))
        .collect();
    format!("{}@{}", words.join(" "), process.to_lowercase())
}

/// A path that worked, and how practised the student is with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct KnownPath {
    pub steps: Vec<Anchor>,
    /// Lessons finished with this path.
    pub runs: u32,
    /// Finished in a row at "corrections only" with no correction (two make it silent).
    pub clean_streak: u32,
    /// Unix seconds (for dropping the oldest when the cache is full).
    pub last_used: u64,
}

pub const CACHE_MAX: usize = 200;
pub const CACHE_FILE: &str = "cursor-paths.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PathCache {
    pub version: u32,
    pub paths: BTreeMap<String, KnownPath>,
}

impl PathCache {
    pub fn parse(text: &str) -> PathCache {
        serde_json::from_str::<PathCache>(text)
            .ok()
            .filter(|c| c.version == 1 && c.paths.len() <= CACHE_MAX * 2)
            .unwrap_or(PathCache {
                version: 1,
                paths: BTreeMap::new(),
            })
    }

    pub fn get(&self, signature: &str) -> Option<&KnownPath> {
        self.paths.get(signature)
    }

    /// Records a finished lesson: its steps (with what was learned), one more run, and whether
    /// it needed no correction.
    pub fn finished(
        &mut self,
        signature: &str,
        steps: Vec<Anchor>,
        clean: bool,
        at_corrections_level: bool,
        now_s: u64,
    ) {
        self.version = 1;
        let entry = self.paths.entry(signature.to_owned()).or_insert(KnownPath {
            steps: Vec::new(),
            runs: 0,
            clean_streak: 0,
            last_used: now_s,
        });
        entry.steps = steps;
        entry.runs += 1;
        entry.clean_streak = if clean && at_corrections_level {
            entry.clean_streak + 1
        } else if clean {
            entry.clean_streak
        } else {
            0
        };
        entry.last_used = now_s;
        while self.paths.len() > CACHE_MAX {
            let oldest = self
                .paths
                .iter()
                .min_by_key(|(_, p)| p.last_used)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => self.paths.remove(&k),
                None => break,
            };
        }
    }

    /// A cached path that led somewhere wrong is forgotten (it'll be planned again).
    pub fn forget(&mut self, signature: &str) {
        self.paths.remove(signature);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::cursor::target::t;

    fn anchor(ty: &str, name: &str, id: &str) -> Anchor {
        Anchor {
            control_type: ty.into(),
            name: name.into(),
            automation_id: id.into(),
            process: String::new(),
        }
    }

    fn settings_window(scale: f64, renamed_id: bool) -> TargetSet {
        // The same Settings window at another scaling: every rectangle is different.
        let s = |v: i32| (f64::from(v) * scale) as i32;
        let mut personal = t(
            1,
            "Personalization",
            "ListItem",
            (s(0), s(200), s(300), s(240)),
        );
        personal.automation_id = if renamed_id {
            "NavItem_7".into()
        } else {
            "SettingsPagePersonalization".into()
        };
        TargetSet {
            process: "systemsettings.exe".into(),
            targets: vec![
                t(0, "System", "ListItem", (s(0), s(160), s(300), s(200))),
                personal,
                t(2, "Colours", "ListItem", (s(320), s(300), s(900), s(340))),
                t(3, "Dark", "RadioButton", (s(320), s(400), s(400), s(420))),
            ],
            ..TargetSet::default()
        }
    }

    #[test]
    fn steps_resolve_at_every_scaling_and_after_an_id_is_renamed() {
        let step = anchor("ListItem", "Personalization", "SettingsPagePersonalization");
        for scale in [1.0, 1.5, 2.0] {
            for renamed in [false, true] {
                let set = settings_window(scale, renamed);
                let found = resolve(&step, &set).expect("resolved");
                assert_eq!(
                    found.name, "Personalization",
                    "scale {scale} renamed {renamed}"
                );
            }
        }
    }

    #[test]
    fn a_close_name_counts_and_a_different_one_doesnt() {
        let set = settings_window(1.0, false);
        // "Colors" planned, the app says "Colours" (another English, or an update).
        assert_eq!(
            resolve(&anchor("ListItem", "Colors", ""), &set).unwrap().id,
            2
        );
        assert!(resolve(&anchor("ListItem", "Bluetooth", ""), &set).is_none());
        // Theme doesn't matter (names and types only); case and accelerators don't either.
        assert_eq!(
            resolve(&anchor("RadioButton", "&dark", ""), &set)
                .unwrap()
                .id,
            3
        );
    }

    #[test]
    fn a_step_in_another_app_waits_for_that_app() {
        let set = settings_window(1.0, false);
        let mut step = anchor("ListItem", "System", "");
        step.process = "explorer.exe".into();
        assert!(resolve(&step, &set).is_none());
        step.process = "systemsettings.exe".into();
        assert!(resolve(&step, &set).is_some());
    }

    #[test]
    fn the_same_request_said_another_way_has_one_signature() {
        let a = signature("How do I turn on dark mode?", "SystemSettings.exe");
        let b = signature("show me how to turn on dark mode", "systemsettings.exe");
        let c = signature("please turn on the dark mode", "systemsettings.exe");
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_ne!(a, signature("turn on dark mode", "explorer.exe"));
    }

    #[test]
    fn the_cache_counts_practice_and_stays_bounded() {
        let mut cache = PathCache::parse("not json");
        let steps = vec![anchor("ListItem", "Personalization", "")];
        cache.finished("dark@x", steps.clone(), true, false, 1);
        cache.finished("dark@x", steps.clone(), true, true, 2);
        cache.finished("dark@x", steps.clone(), true, true, 3);
        assert_eq!(cache.get("dark@x").unwrap().runs, 3);
        assert_eq!(cache.get("dark@x").unwrap().clean_streak, 2);
        cache.finished("dark@x", steps.clone(), false, true, 4);
        assert_eq!(cache.get("dark@x").unwrap().clean_streak, 0);
        for i in 0..(CACHE_MAX + 10) {
            cache.finished(&format!("k{i}"), steps.clone(), true, false, 10 + i as u64);
        }
        assert_eq!(cache.paths.len(), CACHE_MAX);
        let text = serde_json::to_string(&cache).unwrap();
        assert_eq!(PathCache::parse(&text), cache);
    }
}
