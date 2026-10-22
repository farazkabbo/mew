//! Apps Screen Coach never looks at, matched by executable name (brief §7.3, decision 5).
//!
//! The defaults are a starting point the user can edit. Names are best effort: vendors rename
//! executables, so the password-field check and redaction still run everywhere else.

/// Lowercase executable names blocked until the user unblocks them.
pub const DEFAULT_BLOCKED_APPS: &[&str] = &[
    // Password managers
    "1password.exe",
    "bitwarden.exe",
    "dashlane.exe",
    "enpass.exe",
    "keepass.exe",
    "keepassxc.exe",
    "keeperpasswordmanager.exe",
    "lastpass.exe",
    "nordpass.exe",
    "proton pass.exe",
    "roboform.exe",
    // Windows security and sign-in (Settings is blocked whole: decision 5)
    "systemsettings.exe",
    "sechealthui.exe",
    "credentialuibroker.exe",
    "credwiz.exe",
    "consent.exe",
    "logonui.exe",
    "lockapp.exe",
    // Banking and finance
    "gnucash.exe",
    "moneydance.exe",
    "qbw.exe",
    "qbw32.exe",
    "quicken.exe",
    // Mail and messaging (opt-in: the user unblocks them if they want help there)
    "discord.exe",
    "hxoutlook.exe",
    "mailclient.exe",
    "messenger.exe",
    "ms-teams.exe",
    "olk.exe",
    "outlook.exe",
    "signal.exe",
    "skype.exe",
    "slack.exe",
    "teams.exe",
    "telegram.exe",
    "thunderbird.exe",
    "whatsapp.exe",
    "whatsapp.root.exe",
    "zoom.exe",
];

/// Most entries a user's list may hold.
pub const MAX_BLOCKED_APPS: usize = 200;
const MAX_NAME_CHARS: usize = 64;

pub fn default_blocked_apps() -> Vec<String> {
    DEFAULT_BLOCKED_APPS
        .iter()
        .map(|name| (*name).to_owned())
        .collect()
}

/// Cleans up a name typed by the user: trims, lowercases, adds ".exe" if missing, and refuses
/// anything that isn't a plain file name (no paths, no wildcards).
pub fn normalize_app_name(raw: &str) -> Option<String> {
    let mut name = raw.trim().to_lowercase();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return None;
    }
    let plain = name
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ' | '+' | '(' | ')'));
    if !plain || name.starts_with('.') {
        return None;
    }
    if !name.ends_with(".exe") {
        name.push_str(".exe");
    }
    Some(name)
}

/// Normalises a whole list: drops invalid names and duplicates, keeps the user's order.
pub fn normalize_list(raw: &[String]) -> Result<Vec<String>, String> {
    if raw.len() > MAX_BLOCKED_APPS {
        return Err(format!(
            "The blocked list can hold at most {MAX_BLOCKED_APPS} apps."
        ));
    }
    let mut list: Vec<String> = Vec::with_capacity(raw.len());
    for entry in raw {
        let name = normalize_app_name(entry).ok_or_else(|| {
            format!(
                "\"{}\" isn't an app name. Use the program's file name, like notepad.exe.",
                entry.trim()
            )
        })?;
        if !list.contains(&name) {
            list.push(name);
        }
    }
    Ok(list)
}

/// True if `app` (an executable name, any case) is on `blocked`.
pub fn is_blocked(app: &str, blocked: &[String]) -> bool {
    blocked.contains(&app.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_normalised_and_include_the_essentials() {
        for name in DEFAULT_BLOCKED_APPS {
            assert_eq!(normalize_app_name(name).as_deref(), Some(*name), "{name}");
        }
        let defaults = default_blocked_apps();
        for must in [
            "systemsettings.exe",
            "1password.exe",
            "bitwarden.exe",
            "keepassxc.exe",
            "sechealthui.exe",
        ] {
            assert!(is_blocked(must, &defaults), "{must}");
        }
    }

    #[test]
    fn matches_case_insensitively_and_exactly() {
        let blocked = default_blocked_apps();
        assert!(is_blocked("SystemSettings.exe", &blocked));
        assert!(!is_blocked("settings.exe", &blocked));
        assert!(!is_blocked("excel.exe", &blocked));
    }

    #[test]
    fn cleans_up_user_input() {
        assert_eq!(
            normalize_app_name("  Notepad ").as_deref(),
            Some("notepad.exe")
        );
        assert_eq!(
            normalize_app_name("EXCEL.EXE").as_deref(),
            Some("excel.exe")
        );
        assert_eq!(
            normalize_app_name("Proton Pass.exe").as_deref(),
            Some("proton pass.exe")
        );
        for bad in [
            "",
            "   ",
            r"C:\apps\x.exe",
            "../x.exe",
            "*.exe",
            ".exe",
            "a\u{0}b",
            &"x".repeat(80),
        ] {
            assert_eq!(normalize_app_name(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn normalises_lists() {
        let list =
            normalize_list(&["Notepad".into(), "notepad.exe".into(), "slack".into()]).unwrap();
        assert_eq!(list, vec!["notepad.exe", "slack.exe"]);
        assert!(normalize_list(&["ok.exe".into(), r"C:\bad.exe".into()]).is_err());
        assert!(normalize_list(&vec!["a.exe".to_owned(); MAX_BLOCKED_APPS + 1]).is_err());
    }
}
