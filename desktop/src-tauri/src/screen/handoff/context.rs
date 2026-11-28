//! Context for a snapshot (docs/HANDOFF_FEATURE.md §5.2): paths seen in a window, the git repo
//! they're in, and git's read-only answers, parsed. The commands themselves run in
//! `win/git.rs`; the only ones this module ever asks for are in `READ_ONLY`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

use super::timeline::Git;

/// Every git command a snapshot runs: read-only, with a 2-second timeout.
pub const READ_ONLY: [&[&str]; 4] = [
    &["rev-parse", "--abbrev-ref", "HEAD"],
    &["log", "-1", "--format=%h%x09%s"],
    &["status", "--porcelain=v1"],
    &["diff", "--stat"],
];

/// Apps whose windows may hold code: only these get a git snapshot.
pub fn is_editor_or_terminal(process: &str) -> bool {
    matches!(
        process,
        "code.exe"
            | "cursor.exe"
            | "devenv.exe"
            | "idea64.exe"
            | "pycharm64.exe"
            | "webstorm64.exe"
            | "rider64.exe"
            | "notepad++.exe"
            | "sublime_text.exe"
            | "zed.exe"
            | "windowsterminal.exe"
            | "powershell.exe"
            | "pwsh.exe"
            | "cmd.exe"
            | "wsl.exe"
            | "bash.exe"
    )
}

/// Absolute Windows paths in a window title or a terminal prompt ("PS C:\code\neb>").
pub fn paths_in(text: &str) -> Vec<String> {
    static PATH: OnceLock<Regex> = OnceLock::new();
    let re = PATH.get_or_init(|| {
        Regex::new(r#"[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n\s>]*"#).expect("valid")
    });
    re.find_iter(text)
        .map(|m| m.as_str().trim_end_matches(['>', ' ', '.']).to_owned())
        .filter(|p| p.len() > 3)
        .collect()
}

/// The repository a path is in: the nearest folder above it with a `.git` (at most 12 levels).
pub fn repo_of(path: &Path, has_git: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let mut dir = if path.extension().is_some() {
        path.parent()?
    } else {
        path
    };
    for _ in 0..12 {
        if has_git(dir) {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
    None
}

/// Git's four answers as a snapshot's git context (file names and counts, never diff content).
pub fn parse_git(repo: &Path, branch: &str, log: &str, status: &str, diff_stat: &str) -> Git {
    let changed = status.lines().filter(|l| l.len() > 3).count() as u32;
    Git {
        repo: repo
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        branch: branch.trim().chars().take(200).collect(),
        last_commit: log.trim().replace('\t', " ").chars().take(300).collect(),
        changed_files: changed,
        diff_stat: diff_stat
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .take(50)
            .map(|l| l.chars().take(300).collect())
            .collect(),
    }
}

/// The commands a terminal's visible lines show, newest last (at most ten): the text after a
/// prompt ("PS C:\x> ", "C:\x>", "$ ", "> ").
pub fn terminal_commands(lines: &[String]) -> Vec<String> {
    static PROMPT: OnceLock<Regex> = OnceLock::new();
    let re = PROMPT.get_or_init(|| {
        Regex::new(r"^(?:PS [A-Za-z]:\\[^>]*>|[A-Za-z]:\\[^>]*>|[\w.@:~/-]*[$#]|>)\s+(\S.*)$")
            .expect("valid")
    });
    let mut out: Vec<String> = lines
        .iter()
        .filter_map(|l| {
            re.captures(l.trim())
                .map(|c| c[1].chars().take(400).collect())
        })
        .collect();
    let skip = out.len().saturating_sub(10);
    out.split_off(skip)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_paths_and_their_repo() {
        let paths = paths_in("PS C:\\code\\neb\\backend> pnpm test");
        assert_eq!(paths, vec!["C:\\code\\neb\\backend"]);
        let title = paths_in("C:\\Users\\me\\proj\\src\\signup.ts - Notepad++");
        assert_eq!(title, vec!["C:\\Users\\me\\proj\\src\\signup.ts"]);
        // Filesystem traversal uses host-native paths; parsing Windows text above is separate.
        let native_repo = PathBuf::from("workspace").join("proj");
        let source = native_repo.join("src").join("signup.ts");
        let repo = repo_of(&source, |d| d == native_repo);
        assert_eq!(repo, Some(native_repo));
        assert_eq!(
            repo_of(&PathBuf::from("missing").join("project"), |_| false),
            None
        );
    }

    #[test]
    fn git_context_is_names_and_counts() {
        let git = parse_git(
            &PathBuf::from("code").join("neb"),
            "fix-dup-emails\n",
            "a1b2c3d\tdedupe waitlist\n",
            " M signup.ts\n?? notes.md\n",
            " signup.ts | 12 ++++--\n 1 file changed, 9 insertions(+), 3 deletions(-)\n",
        );
        assert_eq!(git.repo, "neb");
        assert_eq!(git.branch, "fix-dup-emails");
        assert_eq!(git.last_commit, "a1b2c3d dedupe waitlist");
        assert_eq!(git.changed_files, 2);
        assert_eq!(git.diff_stat.len(), 2);
    }

    #[test]
    fn every_git_command_is_read_only() {
        for args in READ_ONLY {
            assert!(
                matches!(args[0], "rev-parse" | "log" | "status" | "diff"),
                "{args:?}"
            );
        }
    }

    #[test]
    fn reads_commands_after_prompts() {
        let lines: Vec<String> = [
            "PS C:\\code> git status",
            "On branch main",
            "user@box:~$ pnpm migrate",
            "C:\\x> dir",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        assert_eq!(
            terminal_commands(&lines),
            vec!["git status", "pnpm migrate", "dir"]
        );
    }
}
