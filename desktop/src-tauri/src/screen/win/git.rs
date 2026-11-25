//! Running git for Handoff (docs/HANDOFF_FEATURE.md §5.2, §2.3): `git -C <repo> <args>`, no
//! window, no input, a 2-second timeout for snapshots, and only the arguments `handoff::context`
//! (read-only) and `handoff::pickup::GitStep` (stash, switch, fast-forward pull) produce. No
//! shell is involved: arguments go to git as they are.

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_OUTPUT: usize = 64 * 1024;

/// git's standard output, or None if it failed, timed out or isn't installed.
pub fn run(repo: &Path, args: &[String], timeout: Duration) -> Option<String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        // Never wait for a credential prompt or an editor; don't take locks a read doesn't need.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_EDITOR", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = Vec::new();
                child
                    .stdout
                    .take()?
                    .take(MAX_OUTPUT as u64)
                    .read_to_end(&mut out)
                    .ok()?;
                return status
                    .success()
                    .then(|| String::from_utf8_lossy(&out).into_owned());
            }
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
}

/// A folder is a git repository's top (has a `.git`).
pub fn has_git(dir: &Path) -> bool {
    dir.join(".git").exists()
}
