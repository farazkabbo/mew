//! Keeps the student's pen notes on what they were written on (the island's pen): when the first
//! note is written, the view under it that scrolls (a web page, a PDF) is found with UI
//! Automation, and from then on its scroll position is read a few times a second; the notes
//! move by however far it scrolled. Only the scroll position is read: no text, no pixels.
//! Where nothing scrolls (or UI Automation can't tell), the notes stay where they are.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Runtime};

use super::overlay::{self, Surface};
use super::win::uia::Automation;
use super::win::{target, ComThread};

/// Draw overlay page event: how far to move the notes (CSS pixels).
const NOTES_SHIFT: &str = "mew:draw-notes-shift";
const POLL: Duration = Duration::from_millis(33);
/// Movements smaller than this (physical pixels) are rounding, not scrolling.
const STILL: f64 = 0.5;
/// Looks for the view under the notes (a browser may need a moment to answer).
const FIND_TRIES: u32 = 6;
const FIND_GAP: Duration = Duration::from_millis(300);

/// Which run is current: a new run (or `stop`) ends the one before.
static RUN: AtomicU64 = AtomicU64::new(0);
/// A run is following a view (0: none).
static FOLLOWING: AtomicU64 = AtomicU64::new(0);

/// Starts following the view under (`x`, `y`) (screen pixels), unless one is followed already.
/// `scale` is the draw overlay's physical pixels per CSS pixel.
pub fn follow<R: Runtime>(app: &AppHandle<R>, (x, y): (i32, i32), scale: f64) {
    if FOLLOWING.load(Ordering::SeqCst) != 0 {
        return;
    }
    let run = RUN.fetch_add(1, Ordering::SeqCst) + 1;
    FOLLOWING.store(run, Ordering::SeqCst);
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("mew-note-scroll".into())
        .spawn(move || {
            follow_view(&app, run, (x, y), scale);
            let _ = FOLLOWING.compare_exchange(run, 0, Ordering::SeqCst, Ordering::SeqCst);
        });
    if spawned.is_err() {
        FOLLOWING.store(0, Ordering::SeqCst);
    }
}

/// The notes were cleared: stop following.
pub fn stop() {
    RUN.fetch_add(1, Ordering::SeqCst);
    FOLLOWING.store(0, Ordering::SeqCst);
}

fn follow_view<R: Runtime>(app: &AppHandle<R>, run: u64, (x, y): (i32, i32), scale: f64) {
    let Ok(_com) = ComThread::init() else {
        return;
    };
    // The app under the note (not the one with the focus: Neb's card takes it to type).
    let (Some(window), Ok(automation)) = (target::app_window_at(x, y), Automation::new()) else {
        return;
    };
    // Browsers build their accessibility tree only once something asks for it: the first looks
    // may find nothing yet.
    let mut found = None;
    for _ in 0..FIND_TRIES {
        if RUN.load(Ordering::SeqCst) != run {
            return;
        }
        found = automation.scroller_at(window, x, y);
        if found.is_some() {
            break;
        }
        std::thread::sleep(FIND_GAP);
    }
    let Some(scroller) = found else {
        eprintln!("[screen] pen notes: nothing scrolls under them; they stay put");
        return;
    };
    eprintln!("[screen] pen notes: following the view under them as it scrolls");
    let Some(base) = scroller.offset() else {
        return;
    };
    let mut last = base;
    while RUN.load(Ordering::SeqCst) == run {
        std::thread::sleep(POLL);
        // A view that's gone (its tab closed) keeps the notes where they last were.
        let Some(now) = scroller.offset() else {
            continue;
        };
        if (now.0 - last.0).abs() < STILL && (now.1 - last.1).abs() < STILL {
            continue;
        }
        last = now;
        if RUN.load(Ordering::SeqCst) != run {
            break;
        }
        let scale = scale.max(0.1);
        overlay::dispatch(
            app,
            Surface::Draw,
            NOTES_SHIFT,
            &json!({ "dx": -(now.0 - base.0) / scale, "dy": -(now.1 - base.1) / scale }),
        );
    }
}
