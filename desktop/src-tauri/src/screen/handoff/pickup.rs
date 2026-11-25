//! "Pick up from here" (docs/HANDOFF_FEATURE.md §2.3): what the receiver's desktop app may do,
//! planned from the package and shown to the receiver first, each step confirmed. It reopens the
//! same files (when they exist on this computer) and pages, offers to switch to the same git
//! branch (stashing first if there are changes, never discarding them), and shows the next step.
//! It never runs a build, test or migration command: those are shown with a Copy button.
//!
//! The only git commands this module can produce are in `GitStep::args`, and the test below
//! checks every one of them.

use serde_json::Value;

/// An https address Pick up from here may open (nothing else: no `file:`, `javascript:`, …).
pub fn safe_https(url: &str) -> bool {
    url.starts_with("https://")
        && url.len() <= 2000
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    OpenFile(String),
    OpenUrl(String),
    /// Switch `repo` (a folder on this computer) to `branch`.
    Git {
        repo: String,
        branch: String,
    },
    /// A step for the receiver: clicked with SHOW ME's ghost path, or a command to copy.
    Next {
        text: String,
        kind: String,
        target: Option<String>,
    },
}

/// The git steps Pick up from here may take, and nothing else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitStep {
    /// Read-only: are there uncommitted changes? which branch is this?
    Status,
    Current,
    /// Keeps the receiver's changes (never discards them).
    StashPush,
    Switch(String),
    /// Fast-forward only: never a merge, a rebase or a reset.
    PullFastForward,
}

impl GitStep {
    pub fn args(&self) -> Vec<String> {
        match self {
            GitStep::Status => vec!["status".into(), "--porcelain=v1".into()],
            GitStep::Current => vec!["rev-parse".into(), "--abbrev-ref".into(), "HEAD".into()],
            GitStep::StashPush => vec![
                "stash".into(),
                "push".into(),
                "--include-untracked".into(),
                "-m".into(),
                "neb: before picking up a handoff".into(),
            ],
            // `safe_branch` already ruled out anything that could be read as an option.
            GitStep::Switch(branch) => vec!["switch".into(), branch.clone()],
            GitStep::PullFastForward => vec!["pull".into(), "--ff-only".into()],
        }
    }
}

/// A branch name git would accept, and that can't be read as an option.
pub fn safe_branch(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.contains("..")
        && !name.contains("@{")
        && !name.ends_with(".lock")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/' | '.'))
}

/// The steps for a package's manifest, given which paths and repos exist on this computer
/// (`exists`) and where the receiver's copy of a repo with that name is (`local_repo`).
pub fn plan(
    manifest: &Value,
    exists: impl Fn(&str) -> bool,
    local_repo: impl Fn(&str) -> Option<String>,
) -> Vec<Action> {
    let mut actions = Vec::new();
    let context = manifest["context"].as_array().cloned().unwrap_or_default();
    // The newest snapshot first: where the sender was when they stopped.
    let mut files: Vec<String> = Vec::new();
    let mut urls: Vec<String> = Vec::new();
    let mut git: Option<(String, String)> = None;
    for snap in context.iter().rev() {
        if let Some(path) = snap["path"].as_str() {
            if exists(path) && !files.iter().any(|f| f == path) && files.len() < 3 {
                files.push(path.to_owned());
            }
        }
        if let Some(url) = snap["url"].as_str() {
            if safe_https(url) && !urls.iter().any(|u| u == url) && urls.len() < 3 {
                urls.push(url.to_owned());
            }
        }
        if git.is_none() {
            if let (Some(repo), Some(branch)) =
                (snap["git"]["repo"].as_str(), snap["git"]["branch"].as_str())
            {
                if safe_branch(branch) {
                    if let Some(local) = local_repo(repo) {
                        git = Some((local, branch.to_owned()));
                    }
                }
            }
        }
    }
    actions.extend(files.into_iter().map(Action::OpenFile));
    actions.extend(urls.into_iter().map(Action::OpenUrl));
    if let Some((repo, branch)) = git {
        actions.push(Action::Git { repo, branch });
    }
    for next in manifest["brief"]["next"]
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        let (Some(text), Some(kind)) = (next["text"].as_str(), next["kind"].as_str()) else {
            continue;
        };
        actions.push(Action::Next {
            text: text.chars().take(600).collect(),
            kind: kind.to_owned(),
            target: next["target"]
                .as_str()
                .map(|t| t.chars().take(300).collect()),
        });
    }
    actions
}

/// The git steps for switching to `branch`: with uncommitted changes, stash first only if the
/// receiver chose to (otherwise nothing at all happens).
pub fn git_steps(branch: &str, has_changes: bool, stash_chosen: bool) -> Option<Vec<GitStep>> {
    if !safe_branch(branch) || (has_changes && !stash_chosen) {
        return None;
    }
    let mut steps = Vec::new();
    if has_changes {
        steps.push(GitStep::StashPush);
    }
    steps.push(GitStep::Switch(branch.to_owned()));
    steps.push(GitStep::PullFastForward);
    Some(steps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest() -> Value {
        json!({
            "context": [
                { "path": "C:\\old\\a.ts", "url": "https://old.example.com" },
                { "path": "C:\\code\\neb\\signup.ts", "url": "https://app.example.com/admin?token=hidden",
                  "git": { "repo": "neb", "branch": "fix-dup-emails" } },
                { "url": "javascript:alert(1)", "git": { "repo": "neb", "branch": "--upload-pack=evil" } }
            ],
            "brief": { "next": [
                { "text": "Run the dedupe script", "kind": "command", "target": "pnpm dedupe" },
                { "text": "Press Retry", "kind": "click" }
            ] }
        })
    }

    #[test]
    fn plans_only_what_exists_and_is_safe() {
        let actions = plan(
            &manifest(),
            |p| p == "C:\\code\\neb\\signup.ts",
            |r| (r == "neb").then(|| "D:\\me\\neb".into()),
        );
        assert_eq!(
            actions[0],
            Action::OpenFile("C:\\code\\neb\\signup.ts".into())
        );
        assert!(actions.contains(&Action::OpenUrl(
            "https://app.example.com/admin?token=hidden".into()
        )));
        assert!(!actions
            .iter()
            .any(|a| matches!(a, Action::OpenUrl(u) if u.starts_with("javascript"))));
        assert!(actions.contains(&Action::Git {
            repo: "D:\\me\\neb".into(),
            branch: "fix-dup-emails".into()
        }));
        assert!(
            matches!(&actions[actions.len() - 2], Action::Next { kind, .. } if kind == "command")
        );
    }

    #[test]
    fn uncommitted_changes_need_a_stash_or_nothing_happens() {
        assert_eq!(git_steps("fix-dup-emails", true, false), None);
        let steps = git_steps("fix-dup-emails", true, true).unwrap();
        assert_eq!(steps[0], GitStep::StashPush);
        assert_eq!(
            git_steps("fix-dup-emails", false, false).unwrap()[0],
            GitStep::Switch("fix-dup-emails".into())
        );
        for bad in [
            "-f",
            "--upload-pack=x",
            "a..b",
            "x@{1}",
            "",
            "a b",
            "main;rm",
        ] {
            assert!(git_steps(bad, false, false).is_none(), "{bad}");
        }
    }

    /// The only git commands Pick up from here can run: read-only status and branch, `stash push`,
    /// `switch`, `pull --ff-only`. Never reset, clean, checkout -f, force push, merge or rebase.
    #[test]
    fn every_git_command_is_on_the_list() {
        let allowed = [
            vec!["status", "--porcelain=v1"],
            vec!["rev-parse", "--abbrev-ref", "HEAD"],
            vec![
                "stash",
                "push",
                "--include-untracked",
                "-m",
                "neb: before picking up a handoff",
            ],
            vec!["switch", "fix-dup-emails"],
            vec!["pull", "--ff-only"],
        ];
        let steps = [
            GitStep::Status,
            GitStep::Current,
            GitStep::StashPush,
            GitStep::Switch("fix-dup-emails".into()),
            GitStep::PullFastForward,
        ];
        for (step, want) in steps.iter().zip(allowed) {
            assert_eq!(step.args(), want);
        }
        for step in steps {
            let joined = step.args().join(" ");
            for never in [
                "reset",
                "clean",
                "--force",
                "rebase",
                "merge",
                "checkout",
                "push --force",
                "push -f",
            ] {
                assert!(!joined.contains(never), "{joined}");
            }
        }
    }
}
