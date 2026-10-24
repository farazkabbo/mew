//! Screen Coach's settings: stored on this computer only, read and enforced here in Rust.
//!
//! Decision 1 (docs/SCREEN_COACH.md): security-relevant settings never sync and can't be changed
//! from a web page. Only the local settings page (bundled with the app) edits them, through
//! commands this module's caller exposes to that page alone.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

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

pub const DEFAULT_TALK_HOTKEY: &str = "Ctrl+Alt+Space";
pub const DEFAULT_PAUSE_HOTKEY: &str = "Ctrl+Alt+P";
pub const DEFAULT_CLIP_HOTKEY: &str = "Ctrl+Alt+C";
pub const DEFAULT_NOTES_HOTKEY: &str = "Ctrl+Alt+N";
pub const DEFAULT_DRAW_HOTKEY: &str = "Ctrl+Alt+D";

const FILE_NAME: &str = "screen-coach.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Hotkeys {
    /// Hold to ask about the screen.
    pub talk: String,
    /// Pause or resume Screen Coach.
    pub pause: String,
    /// Save to the notebook (S3; files written before it existed get the default).
    #[serde(default = "default_clip_hotkey")]
    pub clip: String,
    /// Check my notes (Notes Check; files written before it existed get the default).
    #[serde(default = "default_notes_hotkey")]
    pub notes: String,
    /// Draw mode on or off (Circle & Ask, for pen and touch; holding left Ctrl + left Alt draws
    /// too). Files written before it existed get the default.
    #[serde(default = "default_draw_hotkey")]
    pub draw: String,
}

fn default_clip_hotkey() -> String {
    DEFAULT_CLIP_HOTKEY.to_owned()
}

fn default_notes_hotkey() -> String {
    DEFAULT_NOTES_HOTKEY.to_owned()
}

fn default_draw_hotkey() -> String {
    DEFAULT_DRAW_HOTKEY.to_owned()
}

impl Default for Hotkeys {
    fn default() -> Self {
        Self {
            talk: DEFAULT_TALK_HOTKEY.to_owned(),
            pause: DEFAULT_PAUSE_HOTKEY.to_owned(),
            clip: default_clip_hotkey(),
            notes: default_notes_hotkey(),
            draw: default_draw_hotkey(),
        }
    }
}

impl Hotkeys {
    pub fn all(&self) -> [&str; 5] {
        [&self.talk, &self.pause, &self.clip, &self.notes, &self.draw]
    }
}

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
}

impl Default for Privacy {
    fn default() -> Self {
        Self {
            blocked_apps: default_blocked_apps(),
            redaction: RedactionRules::default(),
            ask_scope: CaptureScope::default(),
            pause_during_calls: true,
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

/// The default is everything off: not enabled, no consent, not paused, default hotkeys and
/// default privacy settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ScreenConfig {
    /// The user turned Screen Coach on (off until they do).
    pub enabled: bool,
    /// The version of the explanation the user agreed to when turning it on (0: never).
    pub consent_version: u32,
    /// Paused from the tray or the pause hotkey (survives restarts: a pause is a promise).
    pub paused: bool,
    pub hotkeys: Hotkeys,
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
    let Ok(config) = serde_json::from_str::<ScreenConfig>(text) else {
        return Loaded::Reset(ScreenConfig::default());
    };
    let hotkeys = config.hotkeys.all();
    let shortcuts: Vec<_> = hotkeys
        .iter()
        .filter_map(|text| validate_hotkey(text).ok())
        .collect();
    // All valid, and no two the same.
    let hotkeys_ok = shortcuts.len() == hotkeys.len()
        && shortcuts
            .iter()
            .enumerate()
            .all(|(i, a)| shortcuts[i + 1..].iter().all(|b| a != b));
    // A blocked list that only loads after "cleaning" was edited by hand: start over from the
    // defaults rather than guess what was meant.
    let privacy_ok = config
        .privacy
        .clone()
        .normalized()
        .is_ok_and(|privacy| privacy == config.privacy);
    if hotkeys_ok && privacy_ok {
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

#[derive(Debug, PartialEq, Eq)]
pub enum HotkeyError {
    /// Not a key combination we understand.
    Invalid,
    /// Needs Ctrl or Alt, so ordinary typing never triggers it.
    NeedsModifier,
    /// Windows reserves Win-key combinations.
    UsesWinKey,
    /// Belongs to Windows (Alt+Space opens the window menu, Alt+Tab, Alt+F4, …).
    ReservedBySystem,
}

/// Parses and checks a hotkey the user (or the settings file) chose.
pub fn validate_hotkey(text: &str) -> Result<Shortcut, HotkeyError> {
    let shortcut: Shortcut = text.trim().parse().map_err(|_| HotkeyError::Invalid)?;
    let mods = shortcut.mods;
    if mods.contains(Modifiers::SUPER) || matches!(shortcut.key, Code::MetaLeft | Code::MetaRight) {
        return Err(HotkeyError::UsesWinKey);
    }
    if !mods.intersects(Modifiers::CONTROL | Modifiers::ALT) {
        return Err(HotkeyError::NeedsModifier);
    }
    let only_alt =
        mods.contains(Modifiers::ALT) && !mods.intersects(Modifiers::CONTROL | Modifiers::SHIFT);
    let only_ctrl =
        mods.contains(Modifiers::CONTROL) && !mods.intersects(Modifiers::ALT | Modifiers::SHIFT);
    let ctrl_alt = mods.contains(Modifiers::CONTROL | Modifiers::ALT);
    let reserved = (only_alt
        && matches!(
            shortcut.key,
            Code::Space | Code::Tab | Code::F4 | Code::Escape
        ))
        || (only_ctrl && matches!(shortcut.key, Code::Escape))
        || (ctrl_alt && matches!(shortcut.key, Code::Delete | Code::Backspace))
        || matches!(
            shortcut.key,
            Code::ControlLeft
                | Code::ControlRight
                | Code::AltLeft
                | Code::AltRight
                | Code::ShiftLeft
                | Code::ShiftRight
        );
    if reserved {
        return Err(HotkeyError::ReservedBySystem);
    }
    Ok(shortcut)
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
    fn a_damaged_or_unexpected_file_turns_everything_off() {
        // A file written by S0 (before privacy settings and the clip and notes hotkeys existed)
        // loads with the defaults.
        let on = r#"{"enabled":true,"consentVersion":4,"paused":false,"hotkeys":{"talk":"Ctrl+Alt+Space","pause":"Ctrl+Alt+P"}}"#;
        assert!(matches!(
            parse(on),
            Loaded::Read(c) if c.is_on()
                && c.privacy == Privacy::default()
                && c.hotkeys.clip == DEFAULT_CLIP_HOTKEY
                && c.hotkeys.notes == DEFAULT_NOTES_HOTKEY
                && c.hotkeys.draw == DEFAULT_DRAW_HOTKEY
                && c.circle == CircleSettings::default()
        ));
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
        // The notes hotkey can't share a shortcut with another action either.
        let clash = on.replace(
            r#""pause":"Ctrl+Alt+P""#,
            r#""pause":"Ctrl+Alt+P","notes":"Ctrl+Alt+P""#,
        );
        assert!(matches!(parse(&clash), Loaded::Reset(_)));
        for bad in [
            // Two actions on one shortcut.
            r#"{"enabled":true,"consentVersion":1,"paused":false,"hotkeys":{"talk":"Ctrl+Alt+Space","pause":"Ctrl+Alt+P","clip":"Ctrl+Alt+P"}}"#,
            // A hand-edited blocked list with a path in it.
            r#"{"enabled":true,"consentVersion":1,"paused":false,"hotkeys":{"talk":"Ctrl+Alt+Space","pause":"Ctrl+Alt+P"},"privacy":{"blockedApps":["C:\\x.exe"]}}"#,
            // A privacy setting we don't know.
            r#"{"enabled":true,"consentVersion":1,"paused":false,"hotkeys":{"talk":"Ctrl+Alt+Space","pause":"Ctrl+Alt+P"},"privacy":{"sendEverything":true}}"#,
            "",
            "{",
            "null",
            r#"{"enabled":true}"#,
            // Unknown fields are refused, not ignored.
            r#"{"enabled":true,"consentVersion":1,"paused":false,"hotkeys":{"talk":"Ctrl+Alt+Space","pause":"Ctrl+Alt+P"},"blockedApps":[]}"#,
            // A hotkey that fails validation.
            r#"{"enabled":true,"consentVersion":1,"paused":false,"hotkeys":{"talk":"Alt+Space","pause":"Ctrl+Alt+P"}}"#,
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
            hotkeys: Hotkeys::default(),
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

    #[test]
    fn accepts_sensible_hotkeys() {
        for ok in [
            "Ctrl+Alt+Space",
            "ctrl+alt+space",
            "Ctrl+Alt+C",
            "Ctrl+Shift+M",
            "Alt+Shift+S",
            "Ctrl+F9",
        ] {
            assert!(validate_hotkey(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn refuses_system_and_unsafe_hotkeys() {
        assert_eq!(
            validate_hotkey("Alt+Space"),
            Err(HotkeyError::ReservedBySystem)
        );
        assert_eq!(
            validate_hotkey("Alt+Tab"),
            Err(HotkeyError::ReservedBySystem)
        );
        assert_eq!(
            validate_hotkey("Alt+F4"),
            Err(HotkeyError::ReservedBySystem)
        );
        assert_eq!(
            validate_hotkey("Ctrl+Alt+Delete"),
            Err(HotkeyError::ReservedBySystem)
        );
        assert_eq!(
            validate_hotkey("Ctrl+Escape"),
            Err(HotkeyError::ReservedBySystem)
        );
        assert_eq!(validate_hotkey("Super+Space"), Err(HotkeyError::UsesWinKey));
        assert_eq!(
            validate_hotkey("Ctrl+Super+S"),
            Err(HotkeyError::UsesWinKey)
        );
        assert_eq!(validate_hotkey("Space"), Err(HotkeyError::NeedsModifier));
        assert_eq!(validate_hotkey("Shift+A"), Err(HotkeyError::NeedsModifier));
        assert_eq!(validate_hotkey("Ctrl+Nope"), Err(HotkeyError::Invalid));
        assert_eq!(validate_hotkey(""), Err(HotkeyError::Invalid));
    }
}
