//! Opening an app or a web address for Neb's hand (`screen_hand.rs`), the way the Start menu and
//! a typed address do, without Neb having to find and press its way there.
//!
//! - **An app** is one of the student's own Start menu apps, found by name in Windows' list of
//!   them (`Get-StartApps`: names and app ids, read once per request with a fixed command) and
//!   started by its id through Explorer (`shell:AppsFolder\<id>`). What the model names is only
//!   ever compared with that list (`pick_app`): it never becomes part of a command, so it can't
//!   start anything that isn't an installed app, and never with arguments.
//! - **A web address** is an `https://` address (`safe_url`), handed to Windows' own handler for
//!   links, which opens it in the student's default browser.
//!
//! Neb never opens terminals, shells or tools that change how the computer works
//! (`left_to_the_student`), as it never acts in them.

use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

/// No console window flashes up for the helper processes.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// The longest address Neb opens.
pub const URL_CHARS: usize = 300;

/// One of the student's Start menu apps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartApp {
    pub name: String,
    pub id: String,
}

/// The student's Start menu apps, as Windows lists them. Empty if it couldn't be read.
pub fn start_apps() -> Vec<StartApp> {
    let listed = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match listed {
        Ok(output) if output.status.success() => parse_start_apps(&output.stdout),
        _ => Vec::new(),
    }
}

/// Starts one of the listed apps. False if Windows refused.
pub fn open_app(app: &StartApp) -> bool {
    Command::new("explorer.exe")
        .arg(format!("shell:AppsFolder\\{}", app.id))
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .is_ok()
}

/// Opens a web address in the default browser. False if it isn't one Neb opens, or Windows
/// refused.
pub fn open_url(url: &str) -> bool {
    if !safe_url(url) {
        return false;
    }
    Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .is_ok()
}

// ─── Pure ────────────────────────────────────────────────────────────────────────────────────

/// What `Get-StartApps | ConvertTo-Json` printed: a list of apps, or one app on its own.
pub fn parse_start_apps(json: &[u8]) -> Vec<StartApp> {
    #[derive(serde::Deserialize)]
    struct Listed {
        #[serde(rename = "Name")]
        name: Option<String>,
        #[serde(rename = "AppID")]
        id: Option<String>,
    }
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum Output {
        Many(Vec<Listed>),
        One(Listed),
    }
    // Windows PowerShell may put a byte-order mark first.
    let json = json.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(json);
    let listed = match serde_json::from_slice(json) {
        Ok(Output::Many(apps)) => apps,
        Ok(Output::One(app)) => vec![app],
        Err(_) => return Vec::new(),
    };
    listed
        .into_iter()
        .filter_map(|app| {
            let (name, id) = (app.name?, app.id?);
            let ok = !name.trim().is_empty()
                && !id.trim().is_empty()
                && id.chars().all(|c| !c.is_control() && c != '"');
            ok.then_some(StartApp { name, id })
        })
        .collect()
}

/// Letters and digits only, lowercase, single spaces ("Google Chrome®" → "google chrome").
fn plain(name: &str) -> String {
    name.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Apps Neb leaves to the student: terminals and shells, and tools that change how the computer
/// works or what's installed on it.
const LEFT_TO_THE_STUDENT: &[&str] = &[
    "command prompt",
    "powershell",
    "terminal",
    "cmd",
    "wsl",
    "ubuntu",
    "debian",
    "git bash",
    "git cmd",
    "registry editor",
    "task manager",
    "settings",
    "control panel",
    "run",
    "computer management",
    "services",
    "event viewer",
    "group policy",
    "windows security",
    "uninstall",
    "installer",
    "setup",
];

/// Whether an app, by its name, is one Neb never opens.
pub fn left_to_the_student(name: &str) -> bool {
    let name = format!(" {} ", plain(name));
    LEFT_TO_THE_STUDENT
        .iter()
        .any(|kept| name.contains(&format!(" {kept} ")))
}

/// The installed app that `wanted` names ("chrome" → Google Chrome, "word" → Word): the same
/// name first, then the shortest name that has all of `wanted`'s words as whole words, then one
/// whose own name is inside what was asked for ("the Spotify app"). None if nothing fits or the
/// one that fits is left to the student.
pub fn pick_app<'a>(wanted: &str, apps: &'a [StartApp]) -> Option<&'a StartApp> {
    let wanted = plain(wanted);
    if wanted.is_empty() {
        return None;
    }
    let padded = |text: &str| format!(" {text} ");
    let names: Vec<(String, &StartApp)> = apps.iter().map(|app| (plain(&app.name), app)).collect();
    let same = names.iter().find(|(name, _)| *name == wanted);
    let holds = names
        .iter()
        .filter(|(name, _)| {
            let name = padded(name);
            wanted.split(' ').all(|word| name.contains(&padded(word)))
        })
        .min_by_key(|(name, _)| name.len());
    let held = names
        .iter()
        .filter(|(name, _)| !name.is_empty() && padded(&wanted).contains(&padded(name)))
        .max_by_key(|(name, _)| name.len());
    same.or(holds)
        .or(held)
        .map(|(_, app)| *app)
        .filter(|app| !left_to_the_student(&app.name))
}

/// Whether `url` is a web address Neb opens: `https://`, a host with a dot in it, printable
/// ASCII with no spaces or quotes, no sign-in details in front of the host, not too long.
pub fn safe_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    url.len() <= URL_CHARS
        && url
            .chars()
            .all(|c| c.is_ascii_graphic() && !matches!(c, '"' | '\'' | '`' | '<' | '>' | '\\'))
        && !host.contains('@')
        && host.contains('.')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apps() -> Vec<StartApp> {
        let listed = r#"[
            {"Name":"Brave","AppID":"Brave.ISYNC5KLMKDWMTNNES43CWF4K4"},
            {"Name":"Google Chrome","AppID":"Chrome"},
            {"Name":"Microsoft Edge","AppID":"MSEdge"},
            {"Name":"Spotify","AppID":"SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"},
            {"Name":"Word","AppID":"Microsoft.Office.WINWORD.EXE.15"},
            {"Name":"WordPad","AppID":"wordpad"},
            {"Name":"Windows PowerShell","AppID":"{1AC14E77}\\WindowsPowerShell\\v1.0\\powershell.exe"},
            {"Name":"Visual Studio Code","AppID":"Microsoft.VisualStudioCode"},
            {"Name":"Uninstall Thing","AppID":"thing.uninstall"},
            {"Name":null,"AppID":"x"},
            {"Name":"Bad","AppID":"a\"b"}
        ]"#;
        parse_start_apps(listed.as_bytes())
    }

    fn picked(wanted: &str) -> Option<String> {
        pick_app(wanted, &apps()).map(|app| app.name.clone())
    }

    #[test]
    fn reads_windows_list_of_apps() {
        let apps = apps();
        assert_eq!(apps.len(), 9); // the nameless one and the one with a quote in its id are dropped
        assert_eq!(apps[1].id, "Chrome");
        // One app on its own isn't a list; a byte-order mark may come first.
        let one = parse_start_apps(b"\xEF\xBB\xBF{\"Name\":\"Word\",\"AppID\":\"w\"}");
        assert_eq!(one.len(), 1);
        assert!(parse_start_apps(b"not json").is_empty());
        assert!(parse_start_apps(b"").is_empty());
    }

    #[test]
    fn finds_the_app_that_was_named() {
        assert_eq!(picked("chrome").as_deref(), Some("Google Chrome"));
        assert_eq!(picked("Google Chrome").as_deref(), Some("Google Chrome"));
        assert_eq!(picked("edge").as_deref(), Some("Microsoft Edge"));
        assert_eq!(picked("Spotify").as_deref(), Some("Spotify"));
        // The same name wins over a longer one that starts with it.
        assert_eq!(picked("word").as_deref(), Some("Word"));
        assert_eq!(picked("VS Code"), None); // not its name: the model says the name as listed
        assert_eq!(
            picked("visual studio code").as_deref(),
            Some("Visual Studio Code")
        );
        assert_eq!(picked("the Spotify app").as_deref(), Some("Spotify"));
        assert_eq!(picked("photoshop"), None);
        assert_eq!(picked("  "), None);
    }

    #[test]
    fn never_opens_a_terminal_or_a_system_tool() {
        assert_eq!(picked("powershell"), None);
        assert_eq!(picked("Windows PowerShell"), None);
        assert_eq!(picked("uninstall thing"), None);
        for name in [
            "Command Prompt",
            "Terminal",
            "Windows Terminal Preview",
            "Registry Editor",
            "Settings",
            "Run",
            "Git Bash",
        ] {
            assert!(left_to_the_student(name), "{name}");
        }
        for name in ["Word", "Google Chrome", "Runtime Broker Notes", "Spotify"] {
            assert!(!left_to_the_student(name), "{name}");
        }
    }

    #[test]
    fn opens_only_ordinary_https_addresses() {
        for url in [
            "https://www.google.com/search?q=water+cycle",
            "https://docs.new",
            "https://en.wikipedia.org/wiki/Cat#Etymology",
            "https://www.youtube.com/results?search_query=water%20cycle",
        ] {
            assert!(safe_url(url), "{url}");
        }
        for url in [
            "http://example.com",
            "file:///C:/Windows/System32/cmd.exe",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "https://user:pass@example.com/",
            "https://example.com@evil.example/",
            "https://localhost/",
            "https://exa mple.com/",
            "https://example.com/\"& calc",
            "https://example.com/a\\b",
            "https://",
            "example.com",
            "C:\\Windows\\System32\\calc.exe",
        ] {
            assert!(!safe_url(url), "{url}");
        }
        assert!(!safe_url(&format!(
            "https://example.com/{}",
            "a".repeat(URL_CHARS)
        )));
    }
}
