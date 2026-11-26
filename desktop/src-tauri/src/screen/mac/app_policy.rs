//! Positive macOS application policy. Bundle IDs are never interpreted as Windows filenames.
//! Only these native producers participate in the bounded standard AX focus contract. This
//! identifies the producer, not its document contents, and does not prove call/share absence.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppClass {
    SupportedNative,
    Browser,
    Blocked,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivateState {
    NotApplicableSupportedNative,
    RequiresBrowserEvidence,
    Unknown,
}

pub fn classify_app(bundle_id: &str) -> AppClass {
    let bundle = bundle_id.to_ascii_lowercase();
    match bundle.as_str() {
        "com.apple.textedit"
        | "com.apple.preview"
        | "com.apple.iwork.pages"
        | "com.apple.iwork.numbers"
        | "com.apple.iwork.keynote"
        | "com.microsoft.word"
        | "com.microsoft.excel"
        | "com.microsoft.powerpoint" => AppClass::SupportedNative,
        "com.apple.safari"
        | "com.apple.safaritechnologypreview"
        | "com.google.chrome"
        | "com.google.chrome.beta"
        | "com.google.chrome.canary"
        | "org.mozilla.firefox"
        | "org.mozilla.firefoxdeveloperedition"
        | "com.microsoft.edgemac"
        | "com.brave.browser"
        | "com.operasoftware.opera"
        | "com.vivaldi.vivaldi"
        | "company.thebrowser.browser" => AppClass::Browser,
        _ if sensitive_aliases(&bundle).is_some() => AppClass::Blocked,
        _ => AppClass::Unknown,
    }
}

/// Exact inspected public dictionaries: Chrome and Brave installed scripting.sdef expose
/// read-only window mode normal/incognito and front-to-back index/bounds. Other Chromium
/// brands are not inferred from names or executable suffixes.
pub fn has_inspected_browser_dictionary(bundle: &str) -> bool {
    matches!(bundle, "com.google.Chrome" | "com.brave.Browser")
}

pub fn private_state(bundle_id: &str) -> PrivateState {
    match classify_app(bundle_id) {
        AppClass::SupportedNative => PrivateState::NotApplicableSupportedNative,
        AppClass::Browser => PrivateState::RequiresBrowserEvidence,
        AppClass::Blocked | AppClass::Unknown => PrivateState::Unknown,
    }
}

// Explicit mappings retain the existing cross-platform blocked_apps setting. No substring,
// suffix, localized display name, or inverse Windows-browser test grants access.
fn sensitive_aliases(bundle: &str) -> Option<&'static [&'static str]> {
    Some(match bundle {
        "com.1password.1password" | "com.agilebits.onepassword7" => &["1password.exe"],
        "com.bitwarden.desktop" => &["bitwarden.exe"],
        "com.dashlane.dashlane" => &["dashlane.exe"],
        "in.sinew.enpass" => &["enpass.exe"],
        "org.keepassxc.keepassxc" => &["keepassxc.exe"],
        "com.keepersecurity.keeper" => &["keeperpasswordmanager.exe"],
        "com.lastpass.lastpass" => &["lastpass.exe"],
        "com.nordpass.nordpass" => &["nordpass.exe"],
        "proton.pass" => &["proton pass.exe"],
        "com.apple.systempreferences" | "com.apple.systemsettings" => &["systemsettings.exe"],
        "com.apple.securityagent"
        | "com.apple.keychainaccess"
        | "com.apple.passwords"
        | "com.apple.loginwindow" => &["credentialuibroker.exe"],
        "com.apple.mail" => &["hxoutlook.exe", "mailclient.exe"],
        "com.apple.ichat" => &["messenger.exe"],
        "com.microsoft.outlook" => &["outlook.exe", "olk.exe"],
        "com.hnc.discord" => &["discord.exe"],
        "com.facebook.archon" | "com.facebook.messenger" => &["messenger.exe"],
        "com.microsoft.teams" | "com.microsoft.teams2" => &["teams.exe", "ms-teams.exe"],
        "org.whispersystems.signal-desktop" => &["signal.exe"],
        "com.skype.skype" => &["skype.exe"],
        "com.tinyspeck.slackmacgap" => &["slack.exe"],
        "ru.keepcoder.telegram" | "org.telegram.desktop" => &["telegram.exe"],
        "org.mozilla.thunderbird" => &["thunderbird.exe"],
        "net.whatsapp.whatsapp" | "desktop.whatsapp" => &["whatsapp.exe", "whatsapp.root.exe"],
        "us.zoom.xos" => &["zoom.exe"],
        "org.gnucash.gnucash" => &["gnucash.exe"],
        "com.infinitekind.moneydance" => &["moneydance.exe"],
        "com.quicken.quicken" => &["quicken.exe"],
        _ => return None,
    })
}

/// Return the exact configured entry responsible for refusal. Custom bundle identifiers use
/// the existing setting's normalized `com.example.editor.exe` representation.
pub fn blocked_app(bundle_id: &str, blocked: &[String]) -> Option<String> {
    let bundle = bundle_id.to_ascii_lowercase();
    let custom = format!("{bundle}.exe");
    let aliases: &[&str] = match bundle.as_str() {
        "com.apple.textedit" => &["notepad.exe"],
        "com.apple.preview" => &["preview.exe"],
        "com.apple.iwork.pages" => &["pages.exe"],
        "com.apple.iwork.numbers" => &["numbers.exe"],
        "com.apple.iwork.keynote" => &["keynote.exe"],
        "com.microsoft.word" => &["winword.exe"],
        "com.microsoft.excel" => &["excel.exe"],
        "com.microsoft.powerpoint" => &["powerpnt.exe"],
        "com.apple.safari" => &["safari.exe"],
        "com.google.chrome" => &["chrome.exe"],
        "org.mozilla.firefox" => &["firefox.exe"],
        "com.microsoft.edgemac" => &["msedge.exe"],
        _ => sensitive_aliases(&bundle).unwrap_or(&[]),
    };
    blocked
        .iter()
        .find(|entry| {
            entry.eq_ignore_ascii_case(&custom)
                || aliases
                    .iter()
                    .any(|alias| entry.eq_ignore_ascii_case(alias))
        })
        .cloned()
}

/// Compatibility label for existing server/database app-name contracts. These labels never
/// authorize native access: policy and input remain bound to the real bundle, PID and launch.
pub fn wire_name(bundle: &str) -> Option<&'static str> {
    match bundle.to_ascii_lowercase().as_str() {
        "com.apple.textedit" => Some("textedit.exe"),
        "com.google.chrome" => Some("chrome.exe"),
        "com.brave.browser" => Some("brave.exe"),
        "com.apple.preview" => Some("preview.exe"),
        "com.apple.iwork.pages" => Some("pages.exe"),
        "com.apple.iwork.numbers" => Some("numbers.exe"),
        "com.apple.iwork.keynote" => Some("keynote.exe"),
        "com.microsoft.word" => Some("winword.exe"),
        "com.microsoft.excel" => Some("excel.exe"),
        "com.microsoft.powerpoint" => Some("powerpnt.exe"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_positive_native_producers_exempt_private_browser_evidence() {
        assert_eq!(
            private_state("com.apple.TextEdit"),
            PrivateState::NotApplicableSupportedNative
        );
        for bundle in [
            "com.apple.Safari",
            "com.google.Chrome",
            "org.mozilla.firefox",
        ] {
            assert_eq!(private_state(bundle), PrivateState::RequiresBrowserEvidence);
        }
        for bundle in [
            "org.example.Editor",
            "chrome.exe",
            "com.apple.TextEdit.evil",
            "",
        ] {
            assert_eq!(private_state(bundle), PrivateState::Unknown);
        }
    }

    #[test]
    fn explicit_aliases_and_normalized_custom_bundle_settings_match_exactly() {
        let blocked = vec![
            "systemsettings.exe".into(),
            "1password.exe".into(),
            "slack.exe".into(),
            "excel.exe".into(),
            "com.apple.textedit.exe".into(),
        ];
        for bundle in [
            "com.apple.systempreferences",
            "com.1password.1password",
            "com.tinyspeck.slackmacgap",
            "com.microsoft.Excel",
            "com.apple.TextEdit",
        ] {
            assert!(blocked_app(bundle, &blocked).is_some(), "{bundle}");
        }
        assert!(blocked_app("org.example.slack", &blocked).is_none());
        assert!(blocked_app("com.apple.textedit.evil", &blocked).is_none());
        assert!(blocked_app("com.apple.TextEdit", &[]).is_none());
    }

    #[test]
    fn sensitive_apps_are_never_supported_native_producers() {
        for bundle in [
            "com.apple.mail",
            "com.apple.Passwords",
            "com.microsoft.teams2",
            "com.bitwarden.desktop",
            "com.apple.SecurityAgent",
        ] {
            assert_eq!(classify_app(bundle), AppClass::Blocked);
            assert_eq!(private_state(bundle), PrivateState::Unknown);
        }
    }
}
