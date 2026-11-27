//! Positive metadata-only producers. This never grants capture, AX value reads or native input.
pub fn producer(bundle: &str) -> Option<&'static str> {
    Some(match bundle {
        "com.apple.Terminal" | "com.googlecode.iterm2" => "windowsterminal.exe",
        "com.microsoft.VSCode" | "com.microsoft.VSCodeInsiders" => "code.exe",
        "com.todesktop.230313mzl4w4u92" => "cursor.exe",
        "com.apple.dt.Xcode" => "xcode.exe",
        "com.jetbrains.intellij" | "com.jetbrains.intellij.ce" => "idea64.exe",
        "com.jetbrains.pycharm" | "com.jetbrains.pycharm.ce" => "pycharm64.exe",
        "com.jetbrains.WebStorm" => "webstorm64.exe",
        "com.jetbrains.rider" => "rider64.exe",
        "com.sublimetext.4" | "com.sublimetext.3" => "sublime_text.exe",
        "dev.zed.Zed" => "zed.exe",
        _ => return None,
    })
}
pub fn title_path(title: &str) -> Option<String> {
    if title.len() > 2000 || title.chars().any(char::is_control) {
        return None;
    }
    let start = title
        .find("/Users/")
        .or_else(|| title.find("/Volumes/"))
        .or_else(|| title.find("~/"))?;
    let tail = &title[start..];
    let end = [" — ", " – ", " - ", " • "]
        .iter()
        .filter_map(|split| tail.find(split))
        .min()
        .unwrap_or(tail.len());
    let path = tail[..end].trim().trim_end_matches('>');
    (!path.is_empty()).then(|| path.to_owned())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_producers_are_exact_and_never_include_password_or_browser_apps() {
        assert_eq!(producer("com.apple.Terminal"), Some("windowsterminal.exe"));
        assert_eq!(producer("com.microsoft.VSCode"), Some("code.exe"));
        for id in [
            "com.apple.Terminal.evil",
            "com.apple.Passwords",
            "com.apple.Safari",
            "com.google.Chrome",
            "",
        ] {
            assert!(producer(id).is_none());
        }
    }
    #[test]
    fn unix_paths_keep_spaces_but_never_guess_a_relative_document() {
        assert_eq!(
            title_path("/Users/student/My Work/app/src.rs — Editor"),
            Some("/Users/student/My Work/app/src.rs".into())
        );
        assert_eq!(
            title_path("student — ~/code/project — Terminal"),
            Some("~/code/project".into())
        );
        assert!(title_path("src.rs — Editor").is_none());
    }
}
