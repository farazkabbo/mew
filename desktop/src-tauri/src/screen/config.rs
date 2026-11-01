//! Screen Coach's settings: stored on this computer only, read and enforced here in Rust.
//!
//! Decision 1 (docs/SCREEN_COACH.md): security-relevant settings never sync and can't be changed
//! from a web page. Only the local settings page (bundled with the app) edits them, through
//! commands this module's caller exposes to that page alone.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::pointer::{Corner, PointerShow, PointerSize};
use super::privacy::blocklist::{self, default_blocked_apps};
use super::privacy::detect::RedactionRules;

/// Bumped whenever the explanation the user agrees to (what is seen, when, what's kept) changes
/// in substance: an older consent then no longer counts and Screen Coach stays off until the
/// user reads the new one.
/// 2: S3 added ink on screen (and noticing scrolls while it shows) and saving clips.
/// 3: Notes Check sends the screen's text (after redaction) to compare with your notes, and keeps
///    short quotes from it with the findings.
/// 4: Circle & Ask (S3.2): the pointer beside the cursor, drawing on the screen, and explanations
///    saved to the notebook automatically after a few seconds (with Undo).
pub const CONSENT_VERSION: u32 = 4;

const FILE_NAME: &str = "screen-coach.json";

/// When an explanation is saved to the notebook (decision 11).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SaveMode {
    /// After a 5-second toast with Undo.
    #[default]
    Auto,
    /// Only when the student presses Save in the toast.
    Ask,
    Never,
}

/// Circle & Ask's settings (S3.2 §2.1, §2.5, §4). Every field has a default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase", default)]
pub struct CircleSettings {
    pub pointer: PointerShow,
    pub pointer_size: PointerSize,
    pub pointer_corner: Corner,
    pub save: SaveMode,
    /// Keep the page's title and link with a saved explanation (browsers and videos).
    pub include_source_link: bool,
    /// "I'd rather not use my voice": no microphone, captions instead of speech, keyboard
    /// drawing (§4).
    pub silent: bool,
}

impl Default for CircleSettings {
    fn default() -> Self {
        Self {
            pointer: PointerShow::default(),
            pointer_size: PointerSize::default(),
            pointer_corner: Corner::default(),
            save: SaveMode::default(),
            include_source_link: true,
            silent: false,
        }
    }
}

/// What "Ask about your screen" captures (decision 6: the foreground window by default).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureScope {
    #[default]
    Window,
    Monitor,
}

/// The privacy layer's settings (S1). Every field has a default so settings files written
/// before a field existed still load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase", default)]
pub struct Privacy {
    /// Apps Screen Coach never looks at (lowercase executable names).
    pub blocked_apps: Vec<String>,
    pub redaction: RedactionRules,
    pub ask_scope: CaptureScope,
    /// Don't look or listen during calls and screen recordings (on by default, brief §7.10).
    pub pause_during_calls: bool,
    /// Let screen shares and recordings see Neb's overlays (off by default: they stay out). Neb's
    /// own pictures leave them out either way (`overlay::hide_for_own_capture`).
    pub show_in_captures: bool,
}

impl Default for Privacy {
    fn default() -> Self {
        Self {
            blocked_apps: default_blocked_apps(),
            redaction: RedactionRules::default(),
            ask_scope: CaptureScope::default(),
            pause_during_calls: true,
            show_in_captures: false,
        }
    }
}

impl Privacy {
    /// Checks and cleans settings coming from the settings page or the file.
    pub fn normalized(self) -> Result<Self, String> {
        Ok(Self {
            blocked_apps: blocklist::normalize_list(&self.blocked_apps)?,
            ..self
        })
    }
}

/// The default is everything off: not enabled, no consent, not paused, default privacy settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ScreenConfig {
    /// The user turned Screen Coach on (off until they do).
    pub enabled: bool,
    /// The version of the explanation the user agreed to when turning it on (0: never).
    pub consent_version: u32,
    /// Paused from the tray or by voice (survives restarts: a pause is a promise).
    pub paused: bool,
    /// The three-key hotkeys of S0–S3.2, only ever read from older files: K2 replaced them with
    /// the hold gesture (docs/NOTEBOOKS_K.md §11.1). Never written back.
    #[serde(default, skip_serializing)]
    hotkeys: Option<serde_json::Value>,
    /// "Shortcuts got simpler" is waiting to be read (an older file with hotkeys was loaded).
    #[serde(default)]
    pub shortcuts_notice: bool,
    #[serde(default)]
    pub privacy: Privacy,
    /// The one-time notice that coach mode sees the whole monitor was shown (decision 6, S4).
    #[serde(default)]
    pub coach_notice_seen: bool,
    /// Circle & Ask (S3.2).
    #[serde(default)]
    pub circle: CircleSettings,
}

impl ScreenConfig {
    /// On only if the user turned it on after reading the current explanation.
    pub fn is_on(&self) -> bool {
        self.enabled && self.consent_version >= CONSENT_VERSION
    }
}

/// What loading found. A damaged file never turns anything on: it falls back to the defaults
/// (Screen Coach off) and the settings page says so.
#[derive(Debug, PartialEq, Eq)]
pub enum Loaded {
    Fresh(ScreenConfig),
    Read(ScreenConfig),
    Reset(ScreenConfig),
}

impl Loaded {
    pub fn into_config(self) -> ScreenConfig {
        match self {
            Loaded::Fresh(c) | Loaded::Read(c) | Loaded::Reset(c) => c,
        }
    }
}

pub fn path_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

pub fn parse(text: &str) -> Loaded {
    let Ok(mut config) = serde_json::from_str::<ScreenConfig>(text) else {
        return Loaded::Reset(ScreenConfig::default());
    };
    // Old hotkeys are moved to the new gesture once, whatever they were (K2 §11.4).
    if config.hotkeys.take().is_some() {
        config.shortcuts_notice = true;
    }
    // A blocked list that only loads after "cleaning" was edited by hand: start over from the
    // defaults rather than guess what was meant.
    let privacy_ok = config
        .privacy
        .clone()
        .normalized()
        .is_ok_and(|privacy| privacy == config.privacy);
    if privacy_ok {
        Loaded::Read(config)
    } else {
        Loaded::Reset(ScreenConfig::default())
    }
}

pub fn load(path: &Path) -> Loaded {
    match fs::read_to_string(path) {
        Ok(text) => parse(&text),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Loaded::Fresh(ScreenConfig::default())
        }
        Err(_) => Loaded::Reset(ScreenConfig::default()),
    }
}

/// Writes the settings atomically (a temporary file renamed over the old one), so a crash
/// mid-write can't leave a half-written file.
pub fn save(path: &Path, config: &ScreenConfig) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string_pretty(config).map_err(io::Error::other)?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, text)?;
    fs::rename(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_off_until_the_user_agrees_to_the_current_explanation() {
        let mut config = ScreenConfig::default();
        assert!(!config.is_on());
        config.enabled = true;
        assert!(!config.is_on(), "enabled without consent");
        config.consent_version = CONSENT_VERSION;
        assert!(config.is_on());
        config.consent_version = CONSENT_VERSION - 1;
        assert!(!config.is_on(), "consent to an older explanation");
    }

    #[test]
    fn older_files_load_and_their_hotkeys_become_the_new_gesture() {
        // A file written by S0 (before privacy settings, with the old three-key hotkeys) loads
        // with the defaults; its hotkeys go, and "Shortcuts got simpler" waits to be read.
        let on = r#"{"enabled":true,"consentVersion":4,"paused":false,"hotkeys":{"talk":"Ctrl+Alt+Space","pause":"Ctrl+Alt+P"}}"#;
        let Loaded::Read(config) = parse(on) else {
            panic!("an S0 file should load");
        };
        assert!(config.is_on());
        assert!(config.shortcuts_notice);
        assert_eq!(config.privacy, Privacy::default());
        assert_eq!(config.circle, CircleSettings::default());
        // Saved again, the old hotkeys are gone for good (and the notice is still pending).
        let saved = serde_json::to_string(&config).unwrap();
        assert!(!saved.contains("hotkeys"), "{saved}");
        assert!(matches!(parse(&saved), Loaded::Read(c) if c.shortcuts_notice));
        // Even hotkeys the old version would have refused are just dropped.
        let odd = on.replace("Ctrl+Alt+P", "Alt+Space");
        assert!(matches!(parse(&odd), Loaded::Read(c) if c.is_on() && c.shortcuts_notice));
        // A new file (no hotkeys) has no notice.
        let fresh = r#"{"enabled":true,"consentVersion":4,"paused":false}"#;
        assert!(matches!(parse(fresh), Loaded::Read(c) if c.is_on() && !c.shortcuts_notice));
        // Consent given before S3 explained clips, before Notes Check explained sending the
        // screen's text, or before Circle & Ask explained the pointer and saving, no longer turns
        // Screen Coach on.
        for older in ["1", "2", "3"] {
            let before = on.replace(
                r#""consentVersion":4"#,
                &format!(r#""consentVersion":{older}"#),
            );
            assert!(
                matches!(parse(&before), Loaded::Read(c) if !c.is_on()),
                "{older}"
            );
        }
    }

    #[test]
    fn overlays_stay_out_of_screen_shares_unless_the_student_says_otherwise() {
        // Files written before the setting existed, and damaged ones, keep them hidden.
        let older = r#"{"enabled":true,"consentVersion":4,"paused":false,"privacy":{"pauseDuringCalls":true}}"#;
        assert!(matches!(parse(older), Loaded::Read(c) if !c.privacy.show_in_captures));
        assert!(!parse("{").into_config().privacy.show_in_captures);
        let chosen = older.replace(
            r#""pauseDuringCalls":true"#,
            r#""pauseDuringCalls":true,"showInCaptures":true"#,
        );
        assert!(matches!(parse(&chosen), Loaded::Read(c) if c.privacy.show_in_captures));
    }

    #[test]
    fn a_damaged_or_unexpected_file_turns_everything_off() {
        for bad in [
            // A hand-edited blocked list with a path in it.
            r#"{"enabled":true,"consentVersion":4,"paused":false,"privacy":{"blockedApps":["C:\x.exe"]}}"#,
            // A privacy setting we don't know.
            r#"{"enabled":true,"consentVersion":4,"paused":false,"privacy":{"sendEverything":true}}"#,
            "",
            "{",
            "null",
            r#"{"enabled":true}"#,
            // Unknown fields are refused, not ignored.
            r#"{"enabled":true,"consentVersion":4,"paused":false,"blockedApps":[]}"#,
        ] {
            let loaded = parse(bad);
            assert!(
                matches!(&loaded, Loaded::Reset(c) if !c.is_on()),
                "{bad:?} → {loaded:?}"
            );
        }
    }

    #[test]
    fn saves_and_loads_atomically() {
        let dir =
            std::env::temp_dir().join(format!("mew-screen-config-test-{}", std::process::id()));
        let path = path_in(&dir);
        assert!(matches!(load(&path), Loaded::Fresh(_)));
        let config = ScreenConfig {
            enabled: true,
            consent_version: CONSENT_VERSION,
            paused: true,
            hotkeys: None,
            shortcuts_notice: true,
            privacy: Privacy {
                ask_scope: CaptureScope::Monitor,
                ..Privacy::default()
            },
            coach_notice_seen: true,
            circle: CircleSettings {
                silent: true,
                save: SaveMode::Ask,
                ..CircleSettings::default()
            },
        };
        save(&path, &config).unwrap();
        assert_eq!(load(&path), Loaded::Read(config));
        assert!(!path.with_extension("json.tmp").exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
