//! CATCH ME (docs/CURSOR_MODES.md, G): costly slips caught just before the click. Local, rule
//! based, and never a model call.
//!
//! Each rule names the control it guards (by its name, in English, French and Bengali) and the
//! condition that makes pressing it a likely mistake, read from what UI Automation says about the
//! window (`Facts`). The trigger fires when endpoint prediction says the student is heading for
//! that control (`posterior::Trigger::risky_target`), and as a fallback when the button goes down
//! on it (most controls act when it comes back up). The terminal rule fires on the line being
//! typed, before Enter.
//!
//! Each rule can be snoozed, turned off, or told "not a mistake" (which makes it less eager in
//! that app), and speaks up at most once every two minutes. What's logged is the rule, the app,
//! the time and what the student did: never a name, an address, a draft or a command.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::engine::Update;
use super::posterior::{posterior, Prior, Trigger, TriggerParams};
use super::scene::{caption_at, Scene, Shape};
use super::target::{Target, TargetSet};
use crate::screen::frame::ScreenRect;

/// The rules (CursorSettings' ids).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rule {
    ReplyAll,
    Attachment,
    Unsaved,
    Delete,
    Terminal,
}

impl Rule {
    pub const ALL: [Rule; 5] = [
        Rule::ReplyAll,
        Rule::Attachment,
        Rule::Unsaved,
        Rule::Delete,
        Rule::Terminal,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Rule::ReplyAll => "reply_all",
            Rule::Attachment => "attachment",
            Rule::Unsaved => "unsaved",
            Rule::Delete => "delete",
            Rule::Terminal => "terminal",
        }
    }
}

/// Reply All with at least this many recipients.
pub const REPLY_ALL_MIN: u32 = 5;
/// Deleting more than this many files (or any folder).
pub const DELETE_MIN_FILES: u32 = 20;
/// At most one catch per rule in this long.
pub const RULE_GAP_S: u64 = 120;

fn norm(name: &str) -> String {
    name.trim()
        .trim_end_matches(['…', '.'])
        .to_lowercase()
        .replace('&', "")
}

/// The control a rule guards, by name.
pub fn guards(rule: Rule, target: &Target) -> bool {
    let name = norm(&target.name);
    let button = matches!(
        target.control_type.as_str(),
        "Button" | "SplitButton" | "MenuItem" | "Hyperlink"
    );
    match rule {
        Rule::ReplyAll => {
            button
                && matches!(
                    name.as_str(),
                    "reply all" | "répondre à tous" | "সবাইকে উত্তর দিন" | "সকলকে উত্তর দিন"
                )
        }
        Rule::Attachment => {
            button
                && (matches!(name.as_str(), "send" | "envoyer" | "পাঠান" | "পাঠাও")
                    || name.starts_with("send (") // "Send (Ctrl+Enter)"
                    || name.starts_with("envoyer ("))
        }
        Rule::Unsaved => {
            button
                && (matches!(name.as_str(), "close" | "fermer" | "বন্ধ করুন")
                    || target.automation_id == "Close")
        }
        Rule::Delete => {
            button && matches!(name.as_str(), "delete" | "supprimer" | "মুছুন" | "মুছে ফেলুন")
        }
        Rule::Terminal => false,
    }
}

/// What a rule needs to know about the window, gathered on demand (`win/catch_facts.rs`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    /// Distinct recipients of the message being replied to (addresses, and "N more").
    pub recipients: u32,
    /// Attachment chips in the draft.
    pub attachments: u32,
    /// The draft mentions an attachment ("attached", "ci-joint", "সংযুক্ত"…).
    pub mentions_attachment: bool,
    /// Explorer's selection.
    pub selected_files: u32,
    pub selected_folders: u32,
}

/// The window's title says it has unsaved changes ("*notes.txt - Notepad", "● main.rs",
/// "Untitled (Unsaved)").
pub fn title_unsaved(title: &str) -> bool {
    let t = title.trim();
    let lower = t.to_lowercase();
    t.starts_with('*')
        || t.starts_with('●')
        || t.contains(" *")
        || t.contains("* -")
        || lower.contains("unsaved")
        || lower.contains("not saved")
        || lower.contains("non enregistré")
}

/// Words that say something is attached (English, French, Bengali).
pub fn mentions_attachment(text: &str) -> bool {
    static WORDS: OnceLock<Regex> = OnceLock::new();
    let re = WORDS.get_or_init(|| {
        Regex::new(
            r"(?i)\b(?:attached|attachment|attachments|attaching|enclosed|pfa|pi[eè]ces? jointes?|ci-joint|ci-jointe|en pi[eè]ce jointe)\b|সংযুক্ত|সংযুক্তি",
        )
        .expect("valid")
    });
    re.is_match(text)
}

/// An attachment chip's name: a file name with an extension, often with its size.
pub fn looks_like_attachment(name: &str) -> bool {
    static CHIP: OnceLock<Regex> = OnceLock::new();
    let re = CHIP.get_or_init(|| {
        Regex::new(r"(?i)\.(?:pdf|docx?|xlsx?|pptx?|txt|csv|zip|png|jpe?g|gif|heic|mp4|mov|odt|rtf)\b|\b\d+(?:\.\d+)?\s?(?:kb|mb|gb)\b|^(?:remove )?attachment")
            .expect("valid")
    });
    re.is_match(name)
}

/// What a typed terminal line would destroy, if anything.
pub fn destructive_command(line: &str) -> Option<&'static str> {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        [
            (r"(?i)\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\b", "That deletes everything under it for good, with no Recycle Bin."),
            (r"(?i)\bremove-item\b.*-r(?:ecurse)?\b", "That deletes the folder and everything in it for good."),
            (r"(?i)\b(?:rm|ri|del|rd|rmdir|erase)\b.*\s-r(?:ecurse)?\b.*\s-fo?(?:rce)?\b", "That deletes the folder and everything in it for good."),
            (r"(?i)\b(?:del|erase)\s+(?:/[a-z]\s+)*/s\b", "That deletes files in every folder below this one."),
            (r"(?i)\b(?:rd|rmdir)\s+(?:/[a-z]\s+)*/s\b", "That deletes the folder and everything in it."),
            (r"(?i)\bdrop\s+(?:table|database|schema)\b", "That drops it with all its data."),
            (r"(?i)\btruncate\s+(?:table\s+)?[a-z_`\x22\[]", "That empties the table."),
            (r"(?i)\bgit\s+push\b.*(?:\s--force(?:\s|$)|\s-f(?:\s|$)|\s\+[a-z0-9_/-]+)", "A force push rewrites the shared history."),
            (r"(?i)\bgit\s+reset\s+--hard\b", "That throws away every change you haven't committed."),
            (r"(?i)\bgit\s+clean\s+-[a-z]*f[a-z]*d|\bgit\s+clean\s+-[a-z]*d[a-z]*f", "That deletes every untracked file."),
            (r"(?i)(?:^|[\s;&|])format(?:\.com)?\s+[a-z]:", "That erases the whole drive."),
            (r"(?i)\bformat-volume\b|\bclear-disk\b", "That erases the whole drive."),
        ]
        .into_iter()
        .map(|(p, m)| (Regex::new(p).expect("valid"), m))
        .collect()
    });
    // `--force-with-lease` is the safe kind of force push.
    let line = line.replace("--force-with-lease", "--lease");
    rules
        .iter()
        .find(|(re, _)| re.is_match(&line))
        .map(|(_, m)| *m)
}

/// Whether `rule` applies to `facts` and `set` (the control is there and pressing it now is
/// likely a slip). The terminal rule isn't about a control.
pub fn applies(rule: Rule, set: &TargetSet, facts: &Facts) -> bool {
    match rule {
        Rule::ReplyAll => facts.recipients >= REPLY_ALL_MIN,
        Rule::Attachment => facts.mentions_attachment && facts.attachments == 0,
        Rule::Unsaved => title_unsaved(&set.title),
        Rule::Delete => facts.selected_folders > 0 || facts.selected_files > DELETE_MIN_FILES,
        Rule::Terminal => false,
    }
}

/// The one line said and shown.
pub fn message(rule: Rule, facts: &Facts) -> String {
    match rule {
        Rule::ReplyAll => format!("Reply All goes to {} people.", facts.recipients),
        Rule::Attachment => "You mention an attachment, but nothing's attached.".into(),
        Rule::Unsaved => "This has unsaved changes.".into(),
        Rule::Delete if facts.selected_folders > 0 => "That deletes a whole folder.".into(),
        Rule::Delete => format!("That deletes {} files.", facts.selected_files),
        Rule::Terminal => "That command can't be undone.".into(),
    }
}

/// Which controls in `set` are guarded by which rule (enabled rules only).
pub fn guarded(set: &TargetSet, enabled: &[Rule]) -> Vec<(Rule, u32)> {
    let mut out = Vec::new();
    for t in &set.targets {
        for rule in enabled {
            if guards(*rule, t) {
                out.push((*rule, t.id));
            }
        }
    }
    out
}

/// How eager a rule is in an app after "not a mistake" (each one raises the bar by 0.1).
pub fn p_risky_for(base: f64, not_mistakes: u32) -> f64 {
    (base + 0.1 * f64::from(not_mistakes)).min(0.97)
}

/// One catch per rule every two minutes.
#[derive(Debug, Default)]
pub struct Gaps {
    last: HashMap<Rule, u64>,
}

impl Gaps {
    pub fn may_fire(&self, rule: Rule, now_s: u64) -> bool {
        self.last
            .get(&rule)
            .is_none_or(|&at| now_s >= at + RULE_GAP_S)
    }
    pub fn fired(&mut self, rule: Rule, now_s: u64) {
        self.last.insert(rule, now_s);
    }
}

/// What the student did when caught.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Shown,
    Continued,
    NotAMistake,
    Snoozed,
}

/// One log line: the rule, the app, the time, the outcome. Nothing else can be put in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogEntry {
    pub rule: Rule,
    /// The app's executable name only ("outlook.exe").
    pub app: String,
    pub at: u64,
    pub outcome: Outcome,
}

pub const LOG_FILE: &str = "cursor-catch-log.json";
pub const LOG_MAX: usize = 500;

impl LogEntry {
    /// The app name is reduced to an executable's name (letters, digits, `._-`, ending `.exe`).
    pub fn new(rule: Rule, app: &str, at: u64, outcome: Outcome) -> Self {
        let app: String = app
            .to_lowercase()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || "._-".contains(*c))
            .take(64)
            .collect();
        let app = if app.ends_with(".exe") {
            app
        } else {
            "unknown".into()
        };
        Self {
            rule,
            app,
            at,
            outcome,
        }
    }
}

/// The key "not a mistake" counts are kept under.
pub fn sensitivity_key(rule: Rule, app: &str) -> String {
    format!(
        "{}|{}",
        rule.id(),
        LogEntry::new(rule, app, 0, Outcome::Shown).app
    )
}

/// Counts of "not a mistake" for a rule and app (from the settings).
pub fn not_mistakes(map: &BTreeMap<String, u32>, rule: Rule, app: &str) -> u32 {
    map.get(&sensitivity_key(rule, app)).copied().unwrap_or(0)
}

/// A catch being shown.
#[derive(Debug, Clone, PartialEq)]
pub struct Alert {
    pub rule: Rule,
    pub message: String,
    /// The control it's about (none for the terminal).
    pub rect: Option<ScreenRect>,
    pub at_ms: f64,
}

/// How long a catch stays on screen.
pub const ALERT_MS: f64 = 5000.0;

/// The guarded controls in `set` that apply now (the rule's condition holds and its gap has
/// passed): the ones worth following the pointer for.
pub fn live_risks(
    set: &TargetSet,
    facts: &Facts,
    enabled: &[Rule],
    gaps_ok: impl Fn(Rule) -> bool,
) -> Vec<(Rule, u32)> {
    guarded(set, enabled)
        .into_iter()
        .filter(|(rule, _)| applies(*rule, set, facts) && gaps_ok(*rule))
        .collect()
}

/// CATCH ME's per-frame state: the trigger, the two-minute gaps, the catch on screen.
#[derive(Debug, Default)]
pub struct Catcher {
    trigger: Trigger,
    gaps: Gaps,
    pub alert: Option<Alert>,
    /// The last terminal line caught (the same line isn't caught twice).
    last_line: Option<String>,
}

impl Catcher {
    pub fn may_fire(&self, rule: Rule, now_s: u64) -> bool {
        self.gaps.may_fire(rule, now_s)
    }

    /// One frame: a catch before the click when the pointer is heading for a risky control,
    /// or as the button goes down on it if the prediction missed. Returns a new catch.
    #[allow(clippy::too_many_arguments)]
    pub fn frame(
        &mut self,
        update: &Update,
        set: &TargetSet,
        facts: &Facts,
        enabled: &[Rule],
        params: &TriggerParams,
        sensitivity: &BTreeMap<String, u32>,
        now_ms: f64,
        now_s: u64,
    ) -> Option<Alert> {
        if self
            .alert
            .as_ref()
            .is_some_and(|a| now_ms - a.at_ms > ALERT_MS)
        {
            self.alert = None;
        }
        if update.started {
            self.trigger.reset();
        }
        let risks = live_risks(set, facts, enabled, |r| self.gaps.may_fire(r, now_s));
        if risks.is_empty() || self.alert.is_some() {
            return None;
        }
        let mut hit: Option<(Rule, u32)> = None;
        if let (Some(p), Some(kin)) = (update.prediction, update.kin) {
            let post = posterior(&p, &set.targets, Prior::Uniform, params);
            for (rule, id) in &risks {
                let tuned = TriggerParams {
                    p_risky: p_risky_for(
                        params.p_risky,
                        not_mistakes(sensitivity, *rule, &set.process),
                    ),
                    ..*params
                };
                if self
                    .trigger
                    .risky_target(&p, &kin, update.peak_speed, &post, &[*id], &tuned)
                    .is_some()
                {
                    hit = Some((*rule, *id));
                    break;
                }
            }
        }
        // The fallback: the button went down on it.
        if hit.is_none() {
            if let Some(&(x, y)) = update.clicks.last() {
                hit = risks.iter().copied().find(|(_, id)| {
                    set.get(*id)
                        .is_some_and(|t| t.rect.contains(x as i32, y as i32))
                });
            }
        }
        let (rule, id) = hit?;
        self.gaps.fired(rule, now_s);
        let alert = Alert {
            rule,
            message: message(rule, facts),
            rect: set.get(id).map(|t| t.rect),
            at_ms: now_ms,
        };
        self.alert = Some(alert.clone());
        Some(alert)
    }

    /// The terminal rule: the line being typed, before Enter.
    pub fn terminal(
        &mut self,
        line: &str,
        enabled: &[Rule],
        now_ms: f64,
        now_s: u64,
    ) -> Option<Alert> {
        if !enabled.contains(&Rule::Terminal) {
            return None;
        }
        let line = line.trim();
        let why = destructive_command(line)?;
        if self.last_line.as_deref() == Some(line) || !self.gaps.may_fire(Rule::Terminal, now_s) {
            return None;
        }
        self.last_line = Some(line.to_owned());
        self.gaps.fired(Rule::Terminal, now_s);
        let alert = Alert {
            rule: Rule::Terminal,
            message: format!("Before you press Enter: {why}"),
            rect: None,
            at_ms: now_ms,
        };
        self.alert = Some(alert.clone());
        Some(alert)
    }

    /// The catch's scene: the risky control in amber, and the line beside the cursor.
    pub fn scene(&self, cursor: Option<(f64, f64)>, monitor: ScreenRect, scale: f32) -> Scene {
        let mut scene = Scene::default();
        let Some(alert) = &self.alert else {
            return scene;
        };
        if let Some(rect) = alert.rect {
            scene.shapes.push(Shape::Glow {
                rect,
                scale: 1.15,
                alpha: 1.0,
                warn: true,
            });
        }
        if let Some(at) = cursor {
            scene.shapes.push(Shape::Caption {
                at: caption_at(at, &alert.message, scale, monitor, alert.rect),
                text: alert.message.clone(),
                warn: true,
                scale,
            });
        }
        scene
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::cursor::predict::Prediction;
    use crate::screen::cursor::stream::Kin;
    use crate::screen::cursor::target::t;

    const SCREEN: ScreenRect = ScreenRect {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
    };

    #[test]
    fn catches_before_the_click_on_approach_then_waits_two_minutes() {
        // Reply, Reply all, Forward: 80 px buttons 20 px apart; heading for Reply all.
        let s = set("Re: Trip", &["Reply", "Reply all", "Forward"]);
        let facts = Facts {
            recipients: 30,
            ..Facts::default()
        };
        let mut c = Catcher::default();
        let update = Update {
            kin: Some(Kin {
                x: 140.0,
                y: 15.0,
                vx: 60.0,
                ax: -900.0,
                ..Kin::default()
            }),
            prediction: Some(Prediction {
                endpoint: (140.0, 15.0),
                distance: 400.0,
                progress: 0.9,
                duration_ms: 400.0,
            }),
            peak_speed: 1500.0,
            ..Update::default()
        };
        let params = TriggerParams::default();
        let none = BTreeMap::new();
        let mut caught = None;
        for i in 0..5 {
            let at = f64::from(i) * 8.0;
            caught = caught.or(c.frame(&update, &s, &facts, &Rule::ALL, &params, &none, at, 100));
        }
        let alert = caught.expect("caught on approach");
        assert_eq!(alert.rule, Rule::ReplyAll);
        assert_eq!(alert.message, "Reply All goes to 30 people.");
        assert!(!c.scene(Some((140.0, 15.0)), SCREEN, 1.0).is_empty());
        // Not again within two minutes, even on a click.
        c.alert = None;
        let click = Update {
            clicks: vec![(140.0, 15.0)],
            ..Update::default()
        };
        assert!(c
            .frame(&click, &s, &facts, &Rule::ALL, &params, &none, 100.0, 150)
            .is_none());
        // After two minutes the fallback catches the press itself.
        assert!(c
            .frame(
                &click,
                &s,
                &facts,
                &Rule::ALL,
                &params,
                &none,
                200.0,
                100 + RULE_GAP_S
            )
            .is_some());
    }

    #[test]
    fn stays_silent_on_negative_fixtures() {
        let params = TriggerParams::default();
        let none = BTreeMap::new();
        let click = |x: f64| Update {
            clicks: vec![(x, 15.0)],
            ..Update::default()
        };
        let mut c = Catcher::default();
        // Few recipients; nothing missing; saved; a small selection: pressing each is fine.
        let cases: Vec<(TargetSet, Facts, f64)> = vec![
            (
                set("Re: Trip", &["Reply", "Reply all"]),
                Facts {
                    recipients: 2,
                    ..Facts::default()
                },
                140.0,
            ),
            (
                set("New message", &["Send"]),
                Facts {
                    mentions_attachment: true,
                    attachments: 1,
                    ..Facts::default()
                },
                40.0,
            ),
            (
                set("notes.txt - Notepad", &["Close"]),
                Facts::default(),
                40.0,
            ),
            (
                set("Downloads", &["Delete"]),
                Facts {
                    selected_files: 3,
                    ..Facts::default()
                },
                40.0,
            ),
        ];
        for (s, facts, x) in cases {
            let caught = c.frame(&click(x), &s, &facts, &Rule::ALL, &params, &none, 0.0, 0);
            assert!(caught.is_none(), "{}", s.title);
        }
        // A rule that's off never fires; on, the same press is caught.
        let s = set("*notes.txt - Notepad", &["Close"]);
        let f = Facts::default();
        assert!(c
            .frame(
                &click(40.0),
                &s,
                &f,
                &[Rule::Delete],
                &params,
                &none,
                0.0,
                0
            )
            .is_none());
        assert!(c
            .frame(&click(40.0), &s, &f, &Rule::ALL, &params, &none, 0.0, 0)
            .is_some());
    }

    #[test]
    fn the_terminal_line_is_caught_once() {
        let mut c = Catcher::default();
        assert!(c
            .terminal("PS C:\\code> git status", &Rule::ALL, 0.0, 0)
            .is_none());
        let a = c
            .terminal("PS C:\\code> git reset --hard", &Rule::ALL, 0.0, 0)
            .unwrap();
        assert!(a.message.starts_with("Before you press Enter"));
        assert!(c
            .terminal("PS C:\\code> git reset --hard", &Rule::ALL, 10.0, 500)
            .is_none());
        assert!(c.terminal("rm -rf /", &[Rule::Delete], 0.0, 9999).is_none());
    }

    fn set(title: &str, buttons: &[&str]) -> TargetSet {
        TargetSet {
            process: "app.exe".into(),
            title: title.into(),
            targets: buttons
                .iter()
                .enumerate()
                .map(|(i, n)| {
                    t(
                        i as u32,
                        n,
                        "Button",
                        (100 * i as i32, 0, 100 * i as i32 + 80, 30),
                    )
                })
                .collect(),
            ..TargetSet::default()
        }
    }

    #[test]
    fn reply_all_fires_on_many_recipients_only() {
        let s = set("Re: Trip", &["Reply", "Reply all", "Forward"]);
        assert_eq!(guarded(&s, &Rule::ALL), vec![(Rule::ReplyAll, 1)]);
        let many = Facts {
            recipients: 12,
            ..Facts::default()
        };
        let few = Facts {
            recipients: 2,
            ..Facts::default()
        };
        assert!(applies(Rule::ReplyAll, &s, &many));
        assert!(!applies(Rule::ReplyAll, &s, &few));
        assert_eq!(
            message(Rule::ReplyAll, &many),
            "Reply All goes to 12 people."
        );
    }

    #[test]
    fn attachment_words_without_an_attachment() {
        for draft in [
            "Please find attached the report",
            "PFA",
            "Voici la pièce jointe",
            "ci-joint le contrat",
            "ফাইলটি সংযুক্ত করা হলো",
        ] {
            assert!(mentions_attachment(draft), "{draft}");
        }
        for draft in [
            "I'm attaching importance to this? no",
            "See you tomorrow",
            "The detached house",
        ] {
            // "attaching" counts (it's about to be attached); the others don't.
            assert_eq!(
                mentions_attachment(draft),
                draft.contains("attaching"),
                "{draft}"
            );
        }
        let s = set("New message", &["Send"]);
        let missing = Facts {
            mentions_attachment: true,
            attachments: 0,
            ..Facts::default()
        };
        let there = Facts {
            mentions_attachment: true,
            attachments: 1,
            ..Facts::default()
        };
        assert!(applies(Rule::Attachment, &s, &missing));
        assert!(!applies(Rule::Attachment, &s, &there));
        assert!(looks_like_attachment("report.pdf (234 KB)"));
        assert!(looks_like_attachment("Remove attachment"));
        assert!(!looks_like_attachment("Send"));
    }

    #[test]
    fn closing_with_unsaved_changes() {
        for title in [
            "*notes.txt - Notepad",
            "● main.rs - mew - Visual Studio Code",
            "Document1 (Unsaved) - Word",
            "essay.docx * - Word",
        ] {
            assert!(title_unsaved(title), "{title}");
            assert!(applies(
                Rule::Unsaved,
                &set(title, &["Close"]),
                &Facts::default()
            ));
        }
        for title in ["notes.txt - Notepad", "Inbox - Outlook", "Saved Games"] {
            assert!(!title_unsaved(title), "{title}");
        }
    }

    #[test]
    fn deleting_a_folder_or_many_files() {
        let s = set("Downloads", &["Delete"]);
        assert!(applies(
            Rule::Delete,
            &s,
            &Facts {
                selected_folders: 1,
                ..Facts::default()
            }
        ));
        assert!(applies(
            Rule::Delete,
            &s,
            &Facts {
                selected_files: 21,
                ..Facts::default()
            }
        ));
        assert!(!applies(
            Rule::Delete,
            &s,
            &Facts {
                selected_files: 3,
                ..Facts::default()
            }
        ));
    }

    #[test]
    fn destructive_commands_and_their_safe_neighbours() {
        for bad in [
            "rm -rf build",
            "PS C:\\> Remove-Item .\\data -Recurse -Force",
            "del /s /q *.log",
            "rd /s /q old",
            "rmdir /s temp",
            "mysql> DROP TABLE users;",
            "TRUNCATE TABLE orders",
            "git push --force origin main",
            "git push -f",
            "git reset --hard HEAD~3",
            "git clean -fd",
            "format D:",
        ] {
            assert!(destructive_command(bad).is_some(), "{bad}");
        }
        for fine in [
            "rm notes.txt",
            "ls -la",
            "git push origin main",
            "git push --force-with-lease",
            "git reset --soft HEAD~1",
            "SELECT * FROM users",
            "Remove-Item .\\a.txt",
            "dotnet format",
            "echo truncate",
        ] {
            assert!(destructive_command(fine).is_none(), "{fine}");
        }
    }

    #[test]
    fn rules_name_their_controls_in_three_languages() {
        let s = set(
            "x",
            &[
                "Répondre à tous",
                "Envoyer",
                "Supprimer",
                "Fermer",
                "Send (Ctrl+Enter)",
            ],
        );
        let g = guarded(&s, &Rule::ALL);
        assert!(g.contains(&(Rule::ReplyAll, 0)));
        assert!(g.contains(&(Rule::Attachment, 1)));
        assert!(g.contains(&(Rule::Delete, 2)));
        assert!(g.contains(&(Rule::Unsaved, 3)));
        assert!(g.contains(&(Rule::Attachment, 4)));
        // A turned-off rule guards nothing.
        assert!(guarded(&s, &[Rule::Delete])
            .iter()
            .all(|(r, _)| *r == Rule::Delete));
    }

    #[test]
    fn one_catch_per_rule_every_two_minutes() {
        let mut gaps = Gaps::default();
        assert!(gaps.may_fire(Rule::Delete, 1000));
        gaps.fired(Rule::Delete, 1000);
        assert!(!gaps.may_fire(Rule::Delete, 1000 + RULE_GAP_S - 1));
        assert!(gaps.may_fire(Rule::ReplyAll, 1001));
        assert!(gaps.may_fire(Rule::Delete, 1000 + RULE_GAP_S));
    }

    #[test]
    fn not_a_mistake_makes_a_rule_less_eager_in_that_app() {
        assert_eq!(p_risky_for(0.6, 0), 0.6);
        assert!((p_risky_for(0.6, 2) - 0.8).abs() < 1e-9);
        assert_eq!(p_risky_for(0.6, 9), 0.97);
        let mut map = BTreeMap::new();
        map.insert(sensitivity_key(Rule::ReplyAll, "OUTLOOK.EXE"), 2);
        assert_eq!(not_mistakes(&map, Rule::ReplyAll, "outlook.exe"), 2);
        assert_eq!(not_mistakes(&map, Rule::ReplyAll, "chrome.exe"), 0);
    }

    /// Log entries carry no free text: only these four fields, an enum, a number, and an
    /// executable's name reduced to safe characters.
    #[test]
    fn the_log_never_holds_content() {
        let entry = LogEntry::new(
            Rule::Terminal,
            "C:\\Users\\me\\secret folder\\rm -rf.exe",
            5,
            Outcome::Shown,
        );
        let json = serde_json::to_value(&entry).unwrap();
        let fields: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(fields, vec!["app", "at", "outcome", "rule"]);
        let app = json["app"].as_str().unwrap();
        assert!(
            app.chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)),
            "{app}"
        );
        assert!(!app.contains(' ') && !app.contains('\\'));
        assert_eq!(
            LogEntry::new(Rule::Delete, "a draft about Sam", 1, Outcome::Shown).app,
            "unknown"
        );
        // Nothing else deserialises into it.
        assert!(serde_json::from_str::<LogEntry>(
            r#"{"rule":"delete","app":"x.exe","at":1,"outcome":"shown","text":"hi"}"#
        )
        .is_err());
    }
}
