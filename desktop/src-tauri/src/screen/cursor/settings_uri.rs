//! DO IT's `open_setting` (F): a Settings page by key, mapped here to its `ms-settings:` address.
//! The model only ever names a key from this table (SETTINGS_PAGES in packages/shared/src/
//! screen-plan.ts); an address never comes from it.

/// (key, URI, the breadcrumb shown in the replay).
pub const PAGES: &[(&str, &str, &str)] = &[
    ("display", "ms-settings:display", "System → Display"),
    (
        "night_light",
        "ms-settings:nightlight",
        "System → Display → Night light",
    ),
    ("sound", "ms-settings:sound", "System → Sound"),
    (
        "notifications",
        "ms-settings:notifications",
        "System → Notifications",
    ),
    ("focus", "ms-settings:quiethours", "System → Focus"),
    ("power", "ms-settings:powersleep", "System → Power"),
    (
        "battery",
        "ms-settings:batterysaver",
        "System → Power & battery",
    ),
    ("storage", "ms-settings:storagesense", "System → Storage"),
    ("bluetooth", "ms-settings:bluetooth", "Bluetooth & devices"),
    (
        "printers",
        "ms-settings:printers",
        "Bluetooth & devices → Printers & scanners",
    ),
    (
        "mouse",
        "ms-settings:mousetouchpad",
        "Bluetooth & devices → Mouse",
    ),
    (
        "touchpad",
        "ms-settings:devices-touchpad",
        "Bluetooth & devices → Touchpad",
    ),
    ("typing", "ms-settings:typing", "Time & language → Typing"),
    (
        "network",
        "ms-settings:network-status",
        "Network & internet",
    ),
    (
        "wifi",
        "ms-settings:network-wifi",
        "Network & internet → Wi-Fi",
    ),
    ("vpn", "ms-settings:network-vpn", "Network & internet → VPN"),
    (
        "airplane_mode",
        "ms-settings:network-airplanemode",
        "Network & internet → Airplane mode",
    ),
    (
        "personalization",
        "ms-settings:personalization",
        "Personalization",
    ),
    (
        "background",
        "ms-settings:personalization-background",
        "Personalization → Background",
    ),
    (
        "colors",
        "ms-settings:personalization-colors",
        "Personalization → Colors",
    ),
    (
        "lock_screen",
        "ms-settings:lockscreen",
        "Personalization → Lock screen",
    ),
    ("themes", "ms-settings:themes", "Personalization → Themes"),
    (
        "start",
        "ms-settings:personalization-start",
        "Personalization → Start",
    ),
    (
        "taskbar",
        "ms-settings:taskbar",
        "Personalization → Taskbar",
    ),
    ("apps", "ms-settings:appsfeatures", "Apps → Installed apps"),
    (
        "default_apps",
        "ms-settings:defaultapps",
        "Apps → Default apps",
    ),
    ("startup_apps", "ms-settings:startupapps", "Apps → Startup"),
    ("your_info", "ms-settings:yourinfo", "Accounts → Your info"),
    (
        "sign_in_options",
        "ms-settings:signinoptions",
        "Accounts → Sign-in options",
    ),
    (
        "date_time",
        "ms-settings:dateandtime",
        "Time & language → Date & time",
    ),
    (
        "language",
        "ms-settings:regionlanguage",
        "Time & language → Language & region",
    ),
    (
        "text_size",
        "ms-settings:easeofaccess-display",
        "Accessibility → Text size",
    ),
    (
        "narrator",
        "ms-settings:easeofaccess-narrator",
        "Accessibility → Narrator",
    ),
    (
        "magnifier",
        "ms-settings:easeofaccess-magnifier",
        "Accessibility → Magnifier",
    ),
    (
        "contrast_themes",
        "ms-settings:easeofaccess-highcontrast",
        "Accessibility → Contrast themes",
    ),
    (
        "mouse_pointer",
        "ms-settings:easeofaccess-mousepointer",
        "Accessibility → Mouse pointer and touch",
    ),
    (
        "windows_update",
        "ms-settings:windowsupdate",
        "Windows Update",
    ),
    ("privacy", "ms-settings:privacy", "Privacy & security"),
    (
        "camera_privacy",
        "ms-settings:privacy-webcam",
        "Privacy & security → Camera",
    ),
    (
        "microphone_privacy",
        "ms-settings:privacy-microphone",
        "Privacy & security → Microphone",
    ),
    (
        "location_privacy",
        "ms-settings:privacy-location",
        "Privacy & security → Location",
    ),
    ("about", "ms-settings:about", "System → About"),
    ("clipboard", "ms-settings:clipboard", "System → Clipboard"),
    (
        "multitasking",
        "ms-settings:multitasking",
        "System → Multitasking",
    ),
];

pub fn uri_for(key: &str) -> Option<&'static str> {
    PAGES
        .iter()
        .find(|(k, ..)| *k == key)
        .map(|(_, uri, _)| *uri)
}

pub fn breadcrumb_for(key: &str) -> Option<&'static str> {
    PAGES
        .iter()
        .find(|(k, ..)| *k == key)
        .map(|(.., crumb)| *crumb)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_page_is_a_settings_address_and_keys_are_unique() {
        let mut keys = std::collections::HashSet::new();
        for (key, uri, crumb) in PAGES {
            assert!(keys.insert(*key), "{key}");
            assert!(uri.starts_with("ms-settings:"), "{uri}");
            assert!(
                uri[12..]
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c == '-'),
                "{uri}"
            );
            assert!(!crumb.is_empty());
        }
        assert_eq!(
            uri_for("colors"),
            Some("ms-settings:personalization-colors")
        );
        assert_eq!(uri_for("ms-settings:colors"), None);
        assert_eq!(uri_for("../x"), None);
    }

    #[test]
    fn matches_the_shared_list() {
        // packages/shared/src/screen-plan.ts SETTINGS_PAGES: the same keys, in any order.
        let shared = include_str!("../../../../../packages/shared/src/screen-plan.ts");
        let start = shared.find("export const SETTINGS_PAGES = [").unwrap();
        let end = start + shared[start..].find("] as const").unwrap();
        let listed: std::collections::BTreeSet<&str> =
            shared[start..end].split('"').skip(1).step_by(2).collect();
        let ours: std::collections::BTreeSet<&str> = PAGES.iter().map(|(k, ..)| *k).collect();
        assert_eq!(listed, ours);
    }
}
