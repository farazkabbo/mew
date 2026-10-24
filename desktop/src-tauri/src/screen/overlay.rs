//! Screen Coach's own windows on top of the student's screen (S3): the ink overlay, the ink pill
//! (Save to notebook · Clear) and a clip's preview. Each shows a bundled local page and nothing
//! else: navigation and new windows are refused.
//!
//! - The ink overlay covers one monitor: transparent, click-through, never focused, hidden from
//!   Alt+Tab and the taskbar, and excluded from every capture (ours and screen shares alike).
//!   It receives drawing requests and reports back what it drew; it never sees pixels.
//! - The pill is clickable but never takes focus (the student's app stays active), and is also
//!   excluded from captures.
//! - The Notes Check panel lists a check's findings beside the screen: shown without taking
//!   the focus, clickable and keyboard-usable once the student clicks it, excluded from captures.
//! - The preview is an ordinary focused window: the only WebView that ever sees screen pixels,
//!   and only for a clip the student asked to save (decision 2, S3 §5).
//!
//! Windows are created on first use (off the main thread: building a window from the main
//! thread can deadlock on Windows) and kept hidden between uses.

use serde_json::Value;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    SetWindowDisplayAffinity, SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SW_HIDE, SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE,
};

use super::frame::ScreenRect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Ink,
    Pill,
    Clip,
    Notes,
}

/// Size of the pill, in CSS pixels.
pub const PILL_SIZE: (f64, f64) = (300.0, 52.0);

impl Surface {
    pub const fn label(self) -> &'static str {
        match self {
            Surface::Ink => "screen-ink",
            Surface::Pill => "screen-ink-pill",
            Surface::Clip => "screen-clip",
            Surface::Notes => "screen-notes",
        }
    }

    const fn page(self) -> &'static str {
        match self {
            Surface::Ink => "ink-overlay.html",
            Surface::Pill => "ink-pill.html",
            Surface::Clip => "clip-preview.html",
            Surface::Notes => "notes-panel.html",
        }
    }
}

/// The window for `surface`, created hidden if it doesn't exist yet. Call off the main thread.
pub fn ensure<R: Runtime>(app: &AppHandle<R>, surface: Surface) -> Option<WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(surface.label()) {
        return Some(window);
    }
    let dev_url = app.config().build.dev_url.clone();
    let builder =
        WebviewWindowBuilder::new(app, surface.label(), WebviewUrl::App(surface.page().into()))
            .additional_browser_args(crate::BROWSER_ARGS)
            // Bundled pages only: the page can't be navigated or open anything else.
            .on_navigation(move |url| super::is_local_page(url, dev_url.as_ref()))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .disable_drag_drop_handler()
            .visible(false);
    let builder = match surface {
        Surface::Ink | Surface::Pill => builder
            .title("Mew ink")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .focusable(false)
            .inner_size(
                if surface == Surface::Pill {
                    PILL_SIZE.0
                } else {
                    800.0
                },
                if surface == Surface::Pill {
                    PILL_SIZE.1
                } else {
                    600.0
                },
            ),
        Surface::Notes => builder
            .title("Notes Check · Mew")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .inner_size(380.0, 520.0),
        Surface::Clip => builder
            .title("Save to notebook · Mew")
            .always_on_top(true)
            .inner_size(920.0, 700.0)
            .min_inner_size(520.0, 420.0)
            .center(),
    };
    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            eprintln!(
                "[screen] couldn't open the {} window ({error})",
                surface.label()
            );
            return None;
        }
    };
    if surface == Surface::Ink {
        let _ = window.set_ignore_cursor_events(true);
    }
    if surface != Surface::Clip {
        exclude_from_capture(&window);
    }
    Some(window)
}

/// Keeps a window out of every screen capture (ours, screen shares, recordings).
fn exclude_from_capture<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let raw = hwnd.0 as isize;
    let _ = window.run_on_main_thread(move || {
        // SAFETY: a top-level window of this process, on the thread that owns it.
        if unsafe { SetWindowDisplayAffinity(HWND(raw as *mut _), WDA_EXCLUDEFROMCAPTURE) }.is_err()
        {
            eprintln!("[screen] couldn't exclude an overlay from captures");
        }
    });
}

/// Moves and sizes a window to `rect` (physical pixels). Twice: moving onto a monitor with a
/// different DPI makes Windows resize it on the way; the second call sets the size we want.
pub fn place<R: Runtime>(window: &WebviewWindow<R>, rect: ScreenRect) {
    let position = PhysicalPosition::new(rect.left, rect.top);
    let size = PhysicalSize::new(rect.width().max(1) as u32, rect.height().max(1) as u32);
    let _ = window.set_position(position);
    let _ = window.set_size(size);
    let _ = window.set_position(position);
    let _ = window.set_size(size);
}

/// Shows an overlay window on top without activating it (the student's app keeps the focus).
pub fn show_quietly<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let raw = hwnd.0 as isize;
    let _ = window.run_on_main_thread(move || {
        let hwnd = HWND(raw as *mut _);
        // SAFETY: a window of this process, on its own thread; no pointers.
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    });
}

/// Hides an overlay window (shown with `show_quietly`).
pub fn hide_quietly<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let raw = hwnd.0 as isize;
    let _ = window.run_on_main_thread(move || {
        // SAFETY: a window of this process, on its own thread.
        let _ = unsafe { ShowWindow(HWND(raw as *mut _), SW_HIDE) };
    });
}

/// Hides a surface's window if it exists.
pub fn hide_quietly_named<R: Runtime>(app: &AppHandle<R>, surface: Surface) {
    if let Some(window) = app.get_webview_window(surface.label()) {
        hide_quietly(&window);
    }
}

/// Dispatches `name` with `detail` on a surface's page. Both are serialised as JSON, so text in
/// them arrives as data, never as script.
pub fn dispatch<R: Runtime>(app: &AppHandle<R>, surface: Surface, name: &str, detail: &Value) {
    let Some(window) = app.get_webview_window(surface.label()) else {
        return;
    };
    let (Ok(name), Ok(detail)) = (serde_json::to_string(name), serde_json::to_string(detail))
    else {
        return;
    };
    let _ = window.eval(format!(
        "window.dispatchEvent(new CustomEvent({name}, {{ detail: {detail} }}))"
    ));
}

/// Commands for a surface's page must come from that window, showing its bundled page.
pub fn require_surface<R: Runtime>(
    window: &WebviewWindow<R>,
    surface: Surface,
) -> Result<(), String> {
    let dev_url = window.app_handle().config().build.dev_url.clone();
    let local = window
        .url()
        .is_ok_and(|url| super::is_local_page(&url, dev_url.as_ref()));
    if window.label() == surface.label() && local {
        Ok(())
    } else {
        Err("Not allowed.".to_owned())
    }
}

/// Where the pill goes: just below the ink's bottom-right corner, kept on the monitor (all in
/// physical pixels).
pub fn pill_spot(ink: ScreenRect, monitor: ScreenRect, scale: f64) -> ScreenRect {
    let (w, h) = (
        (PILL_SIZE.0 * scale).round() as i32,
        (PILL_SIZE.1 * scale).round() as i32,
    );
    let gap = (8.0 * scale).round() as i32;
    let left = (ink.right - w).clamp(
        monitor.left + gap,
        (monitor.right - w - gap).max(monitor.left),
    );
    let below = ink.bottom + gap;
    let top = if below + h + gap <= monitor.bottom {
        below
    } else {
        // No room below: above the ink, or failing that, inside the monitor's bottom edge.
        (ink.top - gap - h)
            .max(monitor.top + gap)
            .min(monitor.bottom - h - gap)
    };
    ScreenRect {
        left,
        top,
        right: left + w,
        bottom: top + h,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn puts_the_pill_under_the_ink_and_on_the_monitor() {
        let monitor = ScreenRect {
            left: -2880,
            top: 0,
            right: 0,
            bottom: 1620,
        };
        let ink = ScreenRect {
            left: -2000,
            top: 400,
            right: -1000,
            bottom: 700,
        };
        let spot = pill_spot(ink, monitor, 1.5);
        assert_eq!((spot.width(), spot.height()), (450, 78));
        assert_eq!((spot.right, spot.top), (-1000, 712));

        // Ink at the bottom-right corner: the pill moves above it and stays on screen.
        let corner = ScreenRect {
            left: -600,
            top: 1400,
            right: 0,
            bottom: 1620,
        };
        let spot = pill_spot(corner, monitor, 1.5);
        assert!(spot.right <= monitor.right - 12 && spot.bottom <= corner.top);
    }
}
