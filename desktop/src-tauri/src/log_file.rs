//! Neb's log: in a release build there's no console, so what Neb notes as it works (`eprintln!`
//! lines: timings, statuses, counts) goes to `neb.log` in the app's log folder instead, each line
//! stamped with the local time and the seconds since Neb started. That's what shows where a slow
//! or dropped request lost its time.
//!
//! What goes in is only what was already written for a developer's console, which by design
//! never holds the student's words, screen or file names (`[screen] heard 12 characters`, never
//! what was heard). Keep it so: nothing written with `eprintln!` may carry content.
//!
//! The log is kept small: past `MAX_BYTES` at start-up it becomes `neb.old.log` (replacing the
//! one before) and a new one begins. Debug builds keep writing to the console.

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::time::Instant;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Console::{SetStdHandle, STD_ERROR_HANDLE};
use windows::Win32::System::SystemInformation::GetLocalTime;

pub const FILE: &str = "neb.log";
const OLD: &str = "neb.old.log";
const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Sends this process's stderr to `dir/neb.log` from now on (release builds only).
pub fn start(dir: &Path) {
    if cfg!(debug_assertions) {
        return;
    }
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let path = dir.join(FILE);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&path, dir.join(OLD));
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let Ok((reader, writer)) = std::io::pipe() else {
        return;
    };
    // SAFETY: the pipe's write end is a valid handle, and it's kept open for the rest of the
    // process (forgotten below), so stderr never points at a closed handle.
    if unsafe { SetStdHandle(STD_ERROR_HANDLE, HANDLE(writer.as_raw_handle())) }.is_err() {
        return;
    }
    std::mem::forget(writer);
    let started = Instant::now();
    let _ = writeln!(
        file,
        "{} ---- Neb {} started",
        clock(),
        env!("CARGO_PKG_VERSION")
    );
    let spawned = std::thread::Builder::new()
        .name("mew-log".into())
        .spawn(move || {
            // Every line is read, even if the file can't take it: a full pipe would stall
            // whoever writes next.
            for line in BufReader::new(reader).lines().map_while(Result::ok) {
                let _ = writeln!(
                    file,
                    "{} {:>9.3}s {line}",
                    clock(),
                    started.elapsed().as_secs_f64()
                );
            }
        });
    if spawned.is_err() {
        // Nobody would read the pipe: put stderr back to nothing rather than let it fill.
        // SAFETY: a null handle makes stderr writes fail quietly, as before.
        let _ = unsafe { SetStdHandle(STD_ERROR_HANDLE, HANDLE::default()) };
    }
}

/// The local time, to the millisecond.
fn clock() -> String {
    // SAFETY: no arguments; returns the current local time.
    let t = unsafe { GetLocalTime() };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds
    )
}
