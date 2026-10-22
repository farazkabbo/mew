//! Spotting private browsing windows (InPrivate, Incognito, Private Browsing) from the browser
//! and its window title. Titles are read in memory only, never logged or stored.

const BROWSERS: &[&str] = &[
    "msedge.exe",
    "chrome.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "vivaldi.exe",
    "librewolf.exe",
    "waterfox.exe",
    "arc.exe",
];

/// Words browsers put in a private window's title (Edge: "[InPrivate]", Chrome: "(Incognito)",
/// Firefox: "Private Browsing", Brave/Opera/Vivaldi: "(Private)").
const MARKERS: &[&str] = &[
    "inprivate",
    "incognito",
    "private browsing",
    "(private)",
    "- private",
];

pub fn is_browser(app: &str) -> bool {
    BROWSERS.contains(&app.to_lowercase().as_str())
}

/// True when `title` of a window of `app` marks it as a private browsing window.
pub fn is_private_window(app: &str, title: &str) -> bool {
    if !is_browser(app) {
        return false;
    }
    let title = title.to_lowercase();
    MARKERS.iter().any(|marker| title.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_each_browsers_private_title() {
        assert!(is_private_window(
            "msedge.exe",
            "New tab - [InPrivate] - Microsoft\u{200b} Edge"
        ));
        assert!(is_private_window(
            "chrome.exe",
            "New Tab - Google Chrome (Incognito)"
        ));
        assert!(is_private_window(
            "firefox.exe",
            "Mozilla Firefox Private Browsing"
        ));
        assert!(is_private_window("brave.exe", "New Tab - Brave (Private)"));
        assert!(is_private_window("MSEDGE.EXE", "x - [InPrivate]"));
    }

    #[test]
    fn ignores_normal_windows_and_other_apps() {
        assert!(!is_private_window("chrome.exe", "Inbox - Google Chrome"));
        assert!(!is_private_window(
            "msedge.exe",
            "Privacy settings - Microsoft Edge"
        ));
        // A document titled "Incognito" in Word is just a document.
        assert!(!is_private_window("winword.exe", "Incognito.docx - Word"));
    }
}
