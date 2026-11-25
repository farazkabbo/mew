//! DO IT's `batch_rename` (F): photos renamed by the date each was taken, shown first as a
//! before → after table, done only after the student confirms, and undoable in one step.
//!
//! The undo log is written before anything is renamed (and updated as each rename lands), so an
//! interruption can always be undone. Undo puts back exactly the names that were changed, and
//! only where the renamed file is still there and the old name is still free: it never
//! overwrites anything. Contents are never read or changed.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// At most this many files in one rename.
pub const MAX_FILES: usize = 500;

#[derive(Debug, Clone, PartialEq)]
pub struct Photo {
    pub path: PathBuf,
    /// When it was taken (from its metadata), "YYYY-MM-DDTHH:MM:SS"; else when it was last changed.
    pub taken: Option<String>,
    pub modified: String,
}

/// "2026-05-03 14.22.10" from "2026-05-03T14:22:10…", or None if it doesn't read as a time.
fn stamp(iso: &str) -> Option<String> {
    let b = iso.as_bytes();
    let digits = |r: std::ops::Range<usize>| {
        b.get(r.clone())
            .is_some_and(|s| s.iter().all(u8::is_ascii_digit))
    };
    let ok = b.len() >= 19
        && digits(0..4)
        && b[4] == b'-'
        && digits(5..7)
        && b[7] == b'-'
        && digits(8..10)
        && matches!(b[10], b'T' | b' ')
        && digits(11..13)
        && b[13] == b':'
        && digits(14..16)
        && b[16] == b':'
        && digits(17..19);
    ok.then(|| {
        format!(
            "{} {}.{}.{}",
            &iso[0..10],
            &iso[11..13],
            &iso[14..16],
            &iso[17..19]
        )
    })
}

/// The renames: each photo's new name from its date (taken, else changed), the extension kept,
/// " (2)", " (3)"… where two land on the same name. Photos already named so are left alone.
pub fn plan(photos: &[Photo]) -> Vec<(PathBuf, PathBuf)> {
    let mut taken_names: std::collections::HashSet<PathBuf> =
        photos.iter().map(|p| p.path.clone()).collect();
    let mut sorted: Vec<&Photo> = photos.iter().take(MAX_FILES).collect();
    sorted.sort_by(|a, b| {
        let key = |p: &Photo| p.taken.clone().unwrap_or_else(|| p.modified.clone());
        key(a).cmp(&key(b)).then(a.path.cmp(&b.path))
    });
    let mut out = Vec::new();
    for photo in sorted {
        let Some(base) = photo
            .taken
            .as_deref()
            .and_then(stamp)
            .or_else(|| stamp(&photo.modified))
        else {
            continue;
        };
        let ext = photo
            .path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
            .unwrap_or_default();
        let dir = photo.path.parent().unwrap_or(Path::new(""));
        let current = photo
            .path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if current.to_lowercase().starts_with(&base.to_lowercase()) {
            continue;
        }
        let mut n = 1;
        let target = loop {
            let name = if n == 1 {
                format!("{base}{ext}")
            } else {
                format!("{base} ({n}){ext}")
            };
            let candidate = dir.join(name);
            if !taken_names.contains(&candidate) {
                break candidate;
            }
            n += 1;
        };
        taken_names.remove(&photo.path);
        taken_names.insert(target.clone());
        out.push((photo.path.clone(), target));
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Renamed {
    pub from: PathBuf,
    pub to: PathBuf,
    /// The rename landed.
    pub done: bool,
}

/// The undo log of the last rename (`cursor-rename-undo.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UndoLog {
    pub version: u32,
    pub at: u64,
    pub entries: Vec<Renamed>,
}

pub const UNDO_FILE: &str = "cursor-rename-undo.json";

#[cfg(target_os = "macos")]
fn path_cstring(path: &Path) -> std::io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path contains a NUL byte")
    })
}

/// The destination check must be part of the rename itself: another process can create a
/// file (or a dangling symlink) after the caller's advisory `exists()` check.
#[cfg(target_os = "macos")]
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::ffi::{c_char, c_int, c_uint};

    // Public macOS SDK <sys/stdio.h>, available since macOS 10.12.
    const RENAME_EXCL: c_uint = 0x00000004;
    unsafe extern "C" {
        fn renamex_np(from: *const c_char, to: *const c_char, flags: c_uint) -> c_int;
    }
    let from = path_cstring(from)?;
    let to = path_cstring(to)?;
    // SAFETY: both pointers refer to live NUL-terminated strings; the SDK flag atomically
    // refuses an occupied destination. Preserve the native error, including unsupported FS.
    if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    // Public Kernel32 API. Zero flags deliberately excludes MOVEFILE_REPLACE_EXISTING and
    // COPY_ALLOWED, so an occupied destination or a cross-volume move fails without copying.
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let path_string = |path: &Path| {
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.contains(&0) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "path contains a NUL byte",
            ));
        }
        wide.push(0);
        Ok(wide)
    };
    let from = path_string(from)?;
    let to = path_string(to)?;
    // SAFETY: both pointers refer to live NUL-terminated UTF-16 paths for the entire call.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn rename_no_replace(_from: &Path, _to: &Path) -> std::io::Result<()> {
    // Never fall back to POSIX rename, which replaces an existing destination.
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "atomic no-replace rename is unavailable on this platform",
    ))
}

fn write_log(path: &Path, log: &UndoLog) -> std::io::Result<()> {
    let temp = path.with_extension("json.tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec(log).map_err(std::io::Error::other)?,
    )?;
    std::fs::rename(&temp, path)
}

pub fn read_log(path: &Path) -> Option<UndoLog> {
    let log: UndoLog = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    (log.version == 1).then_some(log)
}

/// Renames, logging first. Never overwrites: a name that's taken by the time it's renamed is
/// skipped. Returns how many were renamed.
pub fn apply(plan: &[(PathBuf, PathBuf)], log_path: &Path, now_s: u64) -> std::io::Result<usize> {
    let mut log = UndoLog {
        version: 1,
        at: now_s,
        entries: plan
            .iter()
            .map(|(from, to)| Renamed {
                from: from.clone(),
                to: to.clone(),
                done: false,
            })
            .collect(),
    };
    write_log(log_path, &log)?;
    let mut count = 0;
    for i in 0..log.entries.len() {
        let (from, to) = (&log.entries[i].from, &log.entries[i].to);
        if to.exists() || !from.exists() {
            continue;
        }
        if rename_no_replace(from, to).is_ok() {
            log.entries[i].done = true;
            count += 1;
            write_log(log_path, &log)?;
        }
    }
    Ok(count)
}

/// Puts the last rename back. Returns how many names were restored; the log is removed when
/// everything is back.
pub fn undo(log_path: &Path) -> std::io::Result<usize> {
    let Some(mut log) = read_log(log_path) else {
        return Ok(0);
    };
    let mut restored = 0;
    for entry in log.entries.iter_mut().rev() {
        if !entry.done {
            continue;
        }
        if entry.to.exists()
            && !entry.from.exists()
            && rename_no_replace(&entry.to, &entry.from).is_ok()
        {
            entry.done = false;
            restored += 1;
        }
    }
    if log.entries.iter().all(|e| !e.done) {
        std::fs::remove_file(log_path)?;
    } else {
        write_log(log_path, &log)?;
    }
    Ok(restored)
}

/// The confirmation's table: "before → after" lines (the first `max`, then "and N more").
pub fn preview(plan: &[(PathBuf, PathBuf)], max: usize) -> String {
    let name = |p: &PathBuf| {
        p.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    };
    let mut lines: Vec<String> = plan
        .iter()
        .take(max)
        .map(|(a, b)| format!("{}  →  {}", name(a), name(b)))
        .collect();
    if plan.len() > max {
        lines.push(format!("…and {} more", plan.len() - max));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mew-rename-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn a_destination_created_after_preflight_is_not_replaced() {
        let dir = temp_dir("racing-destination");
        let source = dir.join("source.jpg");
        let target = dir.join("target.jpg");
        let bytes = [0, 255, 17, 128, 0];
        std::fs::write(&source, bytes).unwrap();
        assert!(!target.exists());
        // Deterministically model another process winning between preflight and rename.
        let racing_target = target.clone();
        std::thread::spawn(move || std::fs::write(racing_target, b"someone else's").unwrap())
            .join()
            .unwrap();
        let error = rename_no_replace(&source, &target).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&source).unwrap(), bytes);
        assert_eq!(std::fs::read(&target).unwrap(), b"someone else's");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_dangling_destination_symlink_is_not_replaced() {
        let dir = temp_dir("dangling-destination");
        let source = dir.join("source.jpg");
        let target = dir.join("target.jpg");
        std::fs::write(&source, b"photo").unwrap();
        std::os::unix::fs::symlink("absent.jpg", &target).unwrap();
        assert!(!target.exists());
        assert_eq!(
            rename_no_replace(&source, &target).unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read(&source).unwrap(), b"photo");
        assert_eq!(
            std::fs::read_link(&target).unwrap(),
            Path::new("absent.jpg")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_path_encoding_preserves_non_utf8_bytes() {
        use std::os::unix::ffi::OsStrExt;
        let path = Path::new(std::ffi::OsStr::from_bytes(b"source-\xff.jpg"));
        assert_eq!(path_cstring(path).unwrap().as_bytes(), b"source-\xff.jpg");
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn exclusive_rename_preserves_file_bytes_in_both_directions() {
        let dir = temp_dir("path-bytes");
        let source = dir.join("source-é.jpg");
        let target = dir.join("target-猫.jpg");
        let bytes = [0, 255, 17, 128, 0];
        std::fs::write(&source, bytes).unwrap();
        rename_no_replace(&source, &target).unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        rename_no_replace(&target, &source).unwrap();
        assert!(!target.exists());
        assert_eq!(std::fs::read(&source).unwrap(), bytes);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn exclusive_rename_rejects_nul_in_either_path() {
        let dir = temp_dir("nul-path");
        let source = dir.join("source.jpg");
        let target = dir.join("target.jpg");
        let invalid = dir.join("bad\0name");
        std::fs::write(&source, b"photo").unwrap();
        for (from, to) in [(&source, &invalid), (&invalid, &target)] {
            assert_eq!(
                rename_no_replace(from, to).unwrap_err().kind(),
                std::io::ErrorKind::InvalidInput
            );
        }
        assert_eq!(std::fs::read(&source).unwrap(), b"photo");
        assert!(!target.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn names_come_from_the_date_taken_and_never_collide() {
        let p = |name: &str, taken: Option<&str>| Photo {
            path: PathBuf::from("photos").join(name),
            taken: taken.map(str::to_owned),
            modified: "2026-01-01T00:00:00".into(),
        };
        let plan = plan(&[
            p("IMG_2.JPG", Some("2026-05-03T14:22:10")),
            p("IMG_1.jpg", Some("2026-05-03T14:22:10")),
            p("IMG_3.png", None),
            p("2026-05-03 09.00.00.jpg", Some("2026-05-03T09:00:00")),
            p("odd.jpg", Some("not a date")),
        ]);
        let names: Vec<String> = plan
            .iter()
            .map(|(_, to)| to.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        // Oldest first; two taken in the same second get (2); one already named is left; one
        // with no readable date falls back to when it was changed.
        assert_eq!(
            names,
            vec![
                "2026-01-01 00.00.00.png",
                "2026-05-03 14.22.10.jpg",
                "2026-05-03 14.22.10 (2).jpg",
                "2026-01-01 00.00.00.jpg",
            ]
        );
    }

    #[test]
    fn undo_restores_exactly() {
        let dir = temp_dir("undo");
        let files = [
            ("IMG_1.jpg", b"one\0\xff\x80".as_slice()),
            ("IMG_2.jpg", b"two"),
            ("IMG_3.heic", b"three"),
        ];
        for (name, bytes) in files {
            std::fs::write(dir.join(name), bytes).unwrap();
        }
        let before: Vec<(String, Vec<u8>)> = listing(&dir);
        let photos: Vec<Photo> = files
            .iter()
            .enumerate()
            .map(|(i, (name, _))| Photo {
                path: dir.join(name),
                taken: Some(format!("2026-05-0{}T10:00:00", i + 1)),
                modified: String::new(),
            })
            .collect();
        let log = dir.join(UNDO_FILE);
        let renames = plan(&photos);
        assert_eq!(apply(&renames, &log, 1).unwrap(), 3);
        assert!(dir.join("2026-05-01 10.00.00.jpg").exists());
        assert!(!dir.join("IMG_1.jpg").exists());
        assert_eq!(undo(&log).unwrap(), 3);
        assert!(!log.exists());
        assert_eq!(listing(&dir), before);
        // Nothing left to undo.
        assert_eq!(undo(&log).unwrap(), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn never_overwrites_on_the_way_or_back() {
        let dir = temp_dir("safe");
        std::fs::write(dir.join("IMG_1.jpg"), b"photo").unwrap();
        std::fs::write(dir.join("2026-05-01 10.00.00.jpg"), b"someone else's").unwrap();
        let renames = vec![(dir.join("IMG_1.jpg"), dir.join("2026-05-01 10.00.00.jpg"))];
        let log = dir.join(UNDO_FILE);
        assert_eq!(apply(&renames, &log, 1).unwrap(), 0);
        assert_eq!(
            std::fs::read(dir.join("2026-05-01 10.00.00.jpg")).unwrap(),
            b"someone else's"
        );
        // A rename that landed, then a new file took the old name: undo leaves both alone.
        std::fs::remove_file(dir.join("2026-05-01 10.00.00.jpg")).unwrap();
        assert_eq!(apply(&renames, &log, 2).unwrap(), 1);
        std::fs::write(dir.join("IMG_1.jpg"), b"new").unwrap();
        assert_eq!(undo(&log).unwrap(), 0);
        assert_eq!(std::fs::read(dir.join("IMG_1.jpg")).unwrap(), b"new");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_preview_is_a_short_table() {
        let plan: Vec<(PathBuf, PathBuf)> = (0..12)
            .map(|i| {
                (
                    PathBuf::from("photos").join(format!("IMG_{i}.jpg")),
                    PathBuf::from("photos").join(format!("2026-01-0{} x.jpg", i % 9)),
                )
            })
            .collect();
        let text = preview(&plan, 10);
        assert!(text.starts_with("IMG_0.jpg  →  2026-01-00 x.jpg"));
        assert!(text.ends_with("…and 2 more"));
    }

    fn listing(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name() != UNDO_FILE)
            .map(|e| {
                (
                    e.file_name().to_string_lossy().to_string(),
                    std::fs::read(e.path()).unwrap(),
                )
            })
            .collect();
        out.sort();
        out
    }
}
