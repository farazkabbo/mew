//! DO IT's allowlist (F) and the rules every chore follows.
//!
//! Only these executors exist: find a file (and open it, or show it in its folder if it would
//! run something), open a Settings page, switch dark or light mode, save the recipe on the page,
//! rename photos by date, rename the selected files the way the student said. Anything else is offered as a SHOW ME lesson: Neb never improvises an
//! action. Renaming is confirmed first and undoable; the theme is switched back the same way it
//! was switched; nothing deletes, sends, buys, overwrites or submits. None of them sends input:
//! they use Windows Search, a Settings address, the theme's two registry values, the clips route
//! and file renames (the input check below keeps it so).

use super::plan::DoAction;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Executor {
    FindFile,
    OpenSetting,
    SetTheme,
    SaveRecipe,
    BatchRename,
    RenameFiles,
}

/// The executor for an action, or None (offer SHOW ME).
pub fn executor_for(action: &DoAction) -> Option<Executor> {
    match action {
        DoAction::FindFile { .. } => Some(Executor::FindFile),
        DoAction::OpenSetting { .. } => Some(Executor::OpenSetting),
        DoAction::SetTheme { .. } => Some(Executor::SetTheme),
        DoAction::SaveRecipe => Some(Executor::SaveRecipe),
        DoAction::BatchRename => Some(Executor::BatchRename),
        DoAction::RenameFiles(_) => Some(Executor::RenameFiles),
        DoAction::ShowMe => None,
    }
}

/// Whether an executor changes files (then it needs a confirmation and an undo log).
pub fn changes_files(executor: Executor) -> bool {
    matches!(executor, Executor::BatchRename | Executor::RenameFiles)
}

/// Dark or light mode, asked for in any plain wording: "turn on dark mode", "switch to light
/// mode", "make it dark mode", "turn off dark mode" (light), "dark theme please". Some(true) for
/// dark. None when it isn't about the theme, when it asks how or where (that's SHOW ME), or when
/// it asks for the Settings page itself ("open dark mode settings": that page opens instead).
pub fn theme_wanted(said: &str) -> Option<bool> {
    let g = said.to_lowercase().replace(['?', '!', '.', ','], " ");
    let g = format!(" {} ", g.split_whitespace().collect::<Vec<_>>().join(" "));
    let has = |w: &str| g.contains(w);
    let dark = has(" dark mode") || has(" dark theme");
    let light = has(" light mode") || has(" light theme");
    if dark == light {
        return None; // neither, or both ("from dark mode to light mode" is planned)
    }
    let learning = [" how ", " where ", " show me ", " teach ", " what "]
        .iter()
        .any(|w| has(w));
    if learning || (has(" open ") && has(" setting")) {
        return None;
    }
    let off = [
        " turn off ",
        " switch off ",
        " disable ",
        " stop ",
        " get rid of ",
        " no more ",
    ]
    .iter()
    .any(|w| has(w));
    Some(dark != off)
}

/// The chores recognised without a plan (no question spent): "save this recipe", "rename these
/// photos by date", dark or light mode ("turn on dark mode": switched, not just opened), and
/// Settings pages named outright ("open Bluetooth settings"). Anything else is planned.
pub fn local_action(goal: &str) -> Option<DoAction> {
    let g = goal.to_lowercase();
    let has = |w: &str| g.contains(w);
    if let Some(dark) = theme_wanted(goal) {
        return Some(DoAction::SetTheme { dark });
    }
    if has("recipe") && (has("save") || has("keep") || has("add")) {
        return Some(DoAction::SaveRecipe);
    }
    if has("rename")
        && (has("photo") || has("picture") || has("image") || has("pic"))
        && has("date")
    {
        return Some(DoAction::BatchRename);
    }
    if let Some(rule) = super::rename_rule::from_words(goal) {
        return Some(DoAction::RenameFiles(rule));
    }
    const PAGES: &[(&str, &str)] = &[
        ("dark mode", "colors"),
        ("light mode", "colors"),
        ("night light", "night_light"),
        ("bluetooth", "bluetooth"),
        ("wi-fi", "wifi"),
        ("wifi", "wifi"),
        ("wallpaper", "background"),
        ("background", "background"),
        ("text bigger", "text_size"),
        ("text size", "text_size"),
        ("display", "display"),
        ("sound", "sound"),
        ("notification", "notifications"),
        ("windows update", "windows_update"),
        ("printer", "printers"),
        ("mouse", "mouse"),
        ("touchpad", "touchpad"),
        ("taskbar", "taskbar"),
        ("language", "language"),
        ("date and time", "date_time"),
        ("battery", "battery"),
        ("storage", "storage"),
    ];
    let wants_setting = has("setting")
        || has("turn on")
        || has("turn off")
        || has("switch to")
        || has("change my")
        || has("make the text");
    if wants_setting {
        if let Some((_, page)) = PAGES.iter().find(|(w, _)| has(w)) {
            return Some(DoAction::OpenSetting {
                page: (*page).to_owned(),
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_four_chores_have_executors() {
        assert_eq!(
            executor_for(&DoAction::SaveRecipe),
            Some(Executor::SaveRecipe)
        );
        assert_eq!(executor_for(&DoAction::ShowMe), None);
        assert!(changes_files(Executor::BatchRename));
        assert!(changes_files(Executor::RenameFiles));
        assert!(!changes_files(Executor::FindFile));
        assert!(!changes_files(Executor::OpenSetting));
        assert!(!changes_files(Executor::SaveRecipe));
    }

    #[test]
    fn plain_chores_need_no_plan() {
        assert_eq!(local_action("save this recipe"), Some(DoAction::SaveRecipe));
        assert_eq!(
            local_action("rename these photos by date"),
            Some(DoAction::BatchRename)
        );
        assert_eq!(
            local_action("turn on dark mode for me"),
            Some(DoAction::SetTheme { dark: true })
        );
        assert_eq!(
            local_action("open dark mode settings"),
            Some(DoAction::OpenSetting {
                page: "colors".into()
            })
        );
        assert_eq!(
            local_action("open my Bluetooth settings"),
            Some(DoAction::OpenSetting {
                page: "bluetooth".into()
            })
        );
        assert_eq!(local_action("find my lease PDF"), None);
        assert_eq!(local_action("delete my photos"), None);
        // Every local page is a real one.
        for goal in [
            "turn on night light",
            "change my wallpaper",
            "make the text bigger",
        ] {
            match local_action(goal) {
                Some(DoAction::OpenSetting { page }) => {
                    assert!(
                        super::super::settings_uri::uri_for(&page).is_some(),
                        "{page}"
                    )
                }
                other => panic!("{goal}: {other:?}"),
            }
        }
    }

    #[test]
    fn dark_and_light_mode_in_plain_words() {
        for said in [
            "turn on dark mode",
            "Neb, turn on dark mode for me please",
            "switch to dark mode",
            "make my computer dark mode",
            "dark mode",
            "dark theme please",
            "turn off light mode",
            "can you put it in dark mode?",
        ] {
            assert_eq!(theme_wanted(said), Some(true), "{said}");
        }
        for said in [
            "turn off dark mode",
            "switch to light mode",
            "light mode please",
            "disable dark mode",
            "go back to light theme",
        ] {
            assert_eq!(theme_wanted(said), Some(false), "{said}");
        }
        for said in [
            "how do I turn on dark mode?",
            "where is dark mode",
            "show me how to turn on dark mode",
            "open dark mode settings",
            "switch from dark mode to light mode",
            "turn on bluetooth",
            "it's dark in here",
        ] {
            assert_eq!(theme_wanted(said), None, "{said}");
        }
    }

    /// The input check (docs/CURSOR_MODES.md, decision 4): nothing outside Neb's hand and its
    /// typing may send input, move the cursor or inject touches. DO IT needs none.
    #[test]
    fn no_code_path_sends_input_outside_the_two_allowed_files() {
        const FORBIDDEN: &[&str] = &[
            "SendInput",
            "SetCursorPos",
            "mouse_event",
            "keybd_event",
            "InjectTouchInput",
            "InjectSyntheticPointerInput",
        ];
        const ALLOWED: &[&str] = &["win/mouse.rs", "win/typing.rs"];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().is_none_or(|e| e != "rs") {
                    continue;
                }
                let rel = path
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if ALLOWED.iter().any(|a| rel.ends_with(a)) || rel.ends_with("cursor/doit.rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap();
                for line in text.lines() {
                    let code = line.split("//").next().unwrap_or("");
                    if FORBIDDEN.iter().any(|f| code.contains(f)) {
                        offenders.push(format!("{rel}: {}", line.trim()));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "input sent outside the allowed files:\n{}",
            offenders.join("\n")
        );
    }
}
