//! Two small notices on the screen (NEB_APP_UI §5.4, U8), plain pages with no script, never
//! focused, click-through and excluded from captures:
//! - the **status capsule**, top-right of the monitor the coach frame is on, for as long as the
//!   frame is held: "neb sees your screen only while this frame is on";
//! - the **keys indicator**, bottom-left of the monitor under the pointer, while Ctrl+Alt is held
//!   with Screen Coach off or paused (the hold that summons Neb's window).
//!
//! Windows are made off the main thread (`overlay::ensure`); a generation per notice keeps a
//! late show from outliving a hide.

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Runtime};

use super::frame::ScreenRect;
use super::overlay::{self, Surface};
use super::win::{input, target};

/// Window sizes, in CSS pixels.
pub const CAPSULE_SIZE: (f64, f64) = (440.0, 52.0);
pub const KEYS_SIZE: (f64, f64) = (500.0, 60.0);
/// From the monitor's edges, clear of the frame's glow (CSS pixels).
const MARGIN: f64 = 48.0;

static CAPSULE: AtomicU64 = AtomicU64::new(0);
static KEYS: AtomicU64 = AtomicU64::new(0);

/// Top-right of `monitor` (physical pixels).
pub fn capsule_spot(monitor: ScreenRect, scale: f64) -> ScreenRect {
    let (w, h, m) = sizes(CAPSULE_SIZE, scale);
    let right = monitor.right - m;
    let top = monitor.top + m;
    ScreenRect {
        left: (right - w).max(monitor.left),
        top,
        right,
        bottom: top + h,
    }
}

/// Bottom-left of `monitor` (physical pixels).
pub fn keys_spot(monitor: ScreenRect, scale: f64) -> ScreenRect {
    let (w, h, m) = sizes(KEYS_SIZE, scale);
    let left = monitor.left + m;
    let bottom = monitor.bottom - m;
    ScreenRect {
        left,
        top: (bottom - h).max(monitor.top),
        right: (left + w).min(monitor.right),
        bottom,
    }
}

fn sizes(size: (f64, f64), scale: f64) -> (i32, i32, i32) {
    (
        (size.0 * scale).round() as i32,
        (size.1 * scale).round() as i32,
        (MARGIN * scale).round() as i32,
    )
}

/// The capsule, on the frame's monitor.
pub fn show_capsule<R: Runtime>(app: &AppHandle<R>, monitor: ScreenRect, dpi: u32) {
    let rect = capsule_spot(monitor, f64::from(dpi.max(96)) / 96.0);
    show(app, Surface::Capsule, &CAPSULE, rect);
}

pub fn hide_capsule<R: Runtime>(app: &AppHandle<R>) {
    hide(app, Surface::Capsule, &CAPSULE);
}

/// The held keys, on the monitor under the pointer.
pub fn show_keys<R: Runtime>(app: &AppHandle<R>) {
    let Some((monitor, dpi)) = input::cursor().and_then(|(x, y)| target::monitor_at(x, y)) else {
        return;
    };
    let rect = keys_spot(monitor, f64::from(dpi.max(96)) / 96.0);
    show(app, Surface::Keys, &KEYS, rect);
}

pub fn hide_keys<R: Runtime>(app: &AppHandle<R>) {
    hide(app, Surface::Keys, &KEYS);
}

fn show<R: Runtime>(
    app: &AppHandle<R>,
    surface: Surface,
    generation: &'static AtomicU64,
    rect: ScreenRect,
) {
    let mine = generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("mew-status".into())
        .spawn(move || {
            let Some(window) = overlay::ensure(&app, surface) else {
                return;
            };
            if generation.load(Ordering::SeqCst) != mine {
                return;
            }
            overlay::place(&window, rect);
            overlay::show_quietly(&window);
            // Hidden meanwhile: hide again (the hide may have run before this show).
            if generation.load(Ordering::SeqCst) != mine {
                overlay::hide_quietly(&window);
            }
        });
    if spawned.is_err() {
        eprintln!("[screen] couldn't show {}", surface.label());
    }
}

fn hide<R: Runtime>(app: &AppHandle<R>, surface: Surface, generation: &AtomicU64) {
    generation.fetch_add(1, Ordering::SeqCst);
    overlay::hide_quietly_named(app, surface);
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: ScreenRect = ScreenRect {
        left: -1920,
        top: 0,
        right: 0,
        bottom: 1080,
    };

    #[test]
    fn the_capsule_sits_top_right_and_the_keys_bottom_left_inside_the_glow() {
        let capsule = capsule_spot(MONITOR, 1.0);
        assert_eq!((capsule.right, capsule.top), (-48, 48));
        assert_eq!((capsule.width(), capsule.height()), (440, 52));
        let keys = keys_spot(MONITOR, 1.5);
        assert_eq!((keys.left, keys.bottom), (-1920 + 72, 1080 - 72));
        assert_eq!((keys.width(), keys.height()), (750, 90));
    }
}
