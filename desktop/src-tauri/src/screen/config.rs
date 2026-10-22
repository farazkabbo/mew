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

/// Bumped whenever the explanation the user agrees to (what is seen, when, what's kept) changes
/// in substance: an older consent then no longer counts and Screen Coach stays off until the
/// user reads the new one.
pub const CONSENT_VERSION: u32 = 1;

pub const DEFAULT_TALK_HOTKEY: &str = "Ctrl+Alt+Space";
pub const DEFAULT_PAUSE_HOTKEY: &str = "Ctrl+Alt+P";

const FILE_NAME: &str = "screen-coach.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Hotkeys {
    /// Hold to ask about the screen.
    pub talk: String,
    /// Pause or resume Screen Coach.
    pub pause: String,
}

impl Default for Hotkeys {
    fn default() -> Self {
        Self {
            talk: DEFAULT_TALK_HOTKEY.to_owned(),
            pause: DEFAULT_PAUSE_HOTKEY.to_owned(),
        }
    }
}

/// The default is everything off: not enabled, no consent, not paused, default hotkeys.
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
    match serde_json::from_str::<ScreenConfig>(text) {
        Ok(config)
            if validate_hotkey(&config.hotkeys.talk).is_ok()
                && validate_hotkey(&config.hotkeys.pause).is_ok() =>
        {
            Loaded::Read(config)
        }
        _ => Loaded::Reset(ScreenConfig::default()),
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
        let on = r#"{"enabled":true,"consentVersion":1,"paused":false,"hotkeys":{"talk":"Ctrl+Alt+Space","pause":"Ctrl+Alt+P"}}"#;
        assert!(matches!(parse(on), Loaded::Read(c) if c.is_on()));
        for bad in [
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
