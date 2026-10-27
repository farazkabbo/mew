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
//! - The progress pill (coach mode, S4) shows the walkthrough's step and its buttons: like the
//!   ink pill, clickable but never focused, and excluded from captures.
//! - Circle & Ask (S3.2): the **pointer** beside the cursor (click-through, never focused); the
//!   **draw overlay** over one monitor (click-through, except while the student draws: then it
//!   takes the mouse, pen and touch, still without taking the focus, unless they draw with the
//!   keyboard); and the **card** (the ask bar, the captions, the save toast), which takes the
//!   focus only when clicked, to type. All excluded from captures; none sees pixels.
//! - The quiz card ("quiz me on this", S6) shows a question, its choices and a box to type the
//!   answer: like the Circle & Ask card, focused only when clicked, excluded from captures.
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
    GetWindowLongPtrW, SetForegroundWindow, SetWindowDisplayAffinity, SetWindowLongPtrW,
    SetWindowPos, ShowWindow, GWL_EXSTYLE, GWL_STYLE, HWND_TOPMOST, SWP_FRAMECHANGED,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE,
    WDA_EXCLUDEFROMCAPTURE, WINDOW_STYLE, WS_CAPTION, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TRANSPARENT, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
};

use super::frame::ScreenRect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Ink,
    Pill,
    Clip,
    Notes,
    Coach,
    Pointer,
    Draw,
    Card,
    /// "Quiz me on this" (S6): the question, its choices, a box to type the answer.
    Quiz,
}

/// Size of the pill, in CSS pixels.
pub const PILL_SIZE: (f64, f64) = (300.0, 52.0);
/// Size of the Circle & Ask card, in CSS pixels (room for a caption and its buttons, targets of
/// at least 44 px: brief §4).
pub const CARD_SIZE: (f64, f64) = (440.0, 236.0);
/// The tallest the card grows to fit what it shows (its destination rows, a long caption, the
/// follow-up box), in CSS pixels; past that the caption scrolls inside it.
pub const CARD_MAX_HEIGHT: f64 = 560.0;

/// The card's window once it fits a page `wanted` CSS pixels tall: as tall as that (between its
/// usual height and `CARD_MAX_HEIGHT`), the same width and top, moved up only as far as it must
/// to stay on the monitor (physical pixels).
pub fn card_fit(window: ScreenRect, monitor: ScreenRect, wanted: f64, scale: f64) -> ScreenRect {
    let css = wanted.clamp(CARD_SIZE.1, CARD_MAX_HEIGHT);
    let height = ((css * scale).round() as i32).min(monitor.height());
    let top = window.top.min(monitor.bottom - height).max(monitor.top);
    ScreenRect {
        left: window.left,
        top,
        right: window.right,
        bottom: top + height,
    }
}

impl Surface {
    pub const fn label(self) -> &'static str {
        match self {
            Surface::Ink => "screen-ink",
            Surface::Pill => "screen-ink-pill",
            Surface::Clip => "screen-clip",
            Surface::Notes => "screen-notes",
            Surface::Coach => "screen-coach-pill",
            Surface::Pointer => "screen-pointer",
            Surface::Draw => "screen-draw",
            Surface::Card => "screen-circle-card",
            Surface::Quiz => "screen-quiz-card",
        }
    }

    const fn page(self) -> &'static str {
        match self {
            Surface::Ink => "ink-overlay.html",
            Surface::Pill => "ink-pill.html",
            Surface::Clip => "clip-preview.html",
            Surface::Notes => "notes-panel.html",
            Surface::Coach => "coach-pill.html",
            Surface::Pointer => "pointer.html",
            Surface::Draw => "draw-overlay.html",
            Surface::Card => "circle-card.html",
            Surface::Quiz => "quiz-card.html",
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
            .title("Neb ink")
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
        Surface::Coach => builder
            .title("Coach · Neb")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .focusable(false)
            .inner_size(
                super::walkthrough::PILL_SIZE.0,
                super::walkthrough::PILL_SIZE.1,
            ),
        Surface::Pointer | Surface::Draw => builder
            .title("Neb")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            // Never focused by a click (drawing mustn't take the student's app's focus); the
            // keyboard gets it only for keyboard drawing (`circle.rs`).
            .focusable(false)
            .inner_size(40.0, 40.0),
        Surface::Card => builder
            .title("Circle & Ask · Neb")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .inner_size(CARD_SIZE.0, CARD_SIZE.1),
        // Like the Circle & Ask card: takes the focus only when clicked, to type.
        Surface::Quiz => builder
            .title("Quiz · Neb")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .inner_size(super::quiz::CARD_SIZE.0, super::quiz::CARD_SIZE.1),
        Surface::Notes => builder
            .title("Notes Check · Neb")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .inner_size(380.0, 520.0),
        Surface::Clip => builder
            .title("Save to notebook · Neb")
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
    // Click-through until told otherwise (the draw overlay, while the student draws).
    if matches!(surface, Surface::Ink | Surface::Pointer | Surface::Draw) {
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
        strip_frame(hwnd);
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

/// The title-bar styles an overlay must never have. tao keeps them on undecorated windows and
/// hides the frame only while it handles WM_NCCALCSIZE, so when that's skipped Windows draws a
/// full title bar (seen on the ink pill, over the pill's buttons).
const FRAME_STYLES: WINDOW_STYLE = WINDOW_STYLE(
    WS_CAPTION.0 | WS_THICKFRAME.0 | WS_SYSMENU.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0,
);

/// `style` without the title bar and frame: a plain popup.
fn frameless(style: WINDOW_STYLE) -> WINDOW_STYLE {
    WINDOW_STYLE((style.0 & !FRAME_STYLES.0) | WS_POPUP.0)
}

/// Removes the title bar and frame styles from an overlay window, on the thread that owns it.
/// Run before every show, since tao writes its styles back whenever its own flags change.
fn strip_frame(hwnd: HWND) {
    // SAFETY: a top-level window of this process, on its own thread; no pointers.
    unsafe {
        let style = WINDOW_STYLE(GetWindowLongPtrW(hwnd, GWL_STYLE) as u32);
        let wanted = frameless(style);
        if wanted != style {
            SetWindowLongPtrW(hwnd, GWL_STYLE, wanted.0 as isize);
            // The frame is recalculated only when told to.
            let _ = SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }
}

// ─── Changing a shown overlay ────────────────────────────────────────────────────────────────
//
// Overlays are shown with `show_quietly` (tao's own `show` would take the focus), so tao thinks
// they're hidden. Its setters must not be used on them once shown: `set_ignore_cursor_events`
// and `set_focusable` write back all of tao's window flags, which hides the window again (the
// draw overlay vanished as draw mode came on, and the drag went to the app below), and
// `set_focus` does nothing for a window it thinks is hidden. These change the window directly.

/// Whether an overlay lets the mouse through to the windows below (tao's styles for it).
pub fn set_click_through<R: Runtime>(window: &WebviewWindow<R>, through: bool) {
    set_ex_style(window, WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0, through);
}

/// Whether an overlay can be activated (keyboard drawing gives it the keyboard).
pub fn set_activatable<R: Runtime>(window: &WebviewWindow<R>, activatable: bool) {
    set_ex_style(window, WS_EX_NOACTIVATE.0, !activatable);
}

/// Gives an overlay the focus. Windows may refuse (focus rules); then the student clicks.
pub fn focus_quietly<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let raw = hwnd.0 as isize;
    let _ = window.run_on_main_thread(move || {
        // SAFETY: a window of this process; plain value arguments.
        let _ = unsafe { SetForegroundWindow(HWND(raw as *mut _)) };
    });
}

/// Sets (`on`) or clears extended style `bits`, on the window's own thread.
fn set_ex_style<R: Runtime>(window: &WebviewWindow<R>, bits: u32, on: bool) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let raw = hwnd.0 as isize;
    let _ = window.run_on_main_thread(move || {
        let hwnd = HWND(raw as *mut _);
        // SAFETY: a top-level window of this process, on its own thread; no pointers.
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let wanted = if on { style | bits } else { style & !bits };
            if wanted != style {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted as isize);
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    0,
                    0,
                    0,
                    0,
                    SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
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

/// Moves a window to `rect` (physical pixels) from any thread, without activating it, and
/// without waiting for its thread: the pointer follows the cursor this way every frame.
pub fn move_quickly<R: Runtime>(window: &WebviewWindow<R>, rect: ScreenRect) {
    use windows::Win32::UI::WindowsAndMessaging::{SWP_ASYNCWINDOWPOS, SWP_NOZORDER};
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    // SAFETY: a window of this process; SWP_ASYNCWINDOWPOS posts the change to its own thread.
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            None,
            rect.left,
            rect.top,
            rect.width().max(1),
            rect.height().max(1),
            SWP_NOACTIVATE | SWP_NOZORDER | SWP_ASYNCWINDOWPOS,
        )
    };
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
    use windows::Win32::UI::WindowsAndMessaging::{WS_CLIPSIBLINGS, WS_VISIBLE};

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> ScreenRect {
        ScreenRect {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn the_card_grows_to_fit_what_it_shows_and_stays_on_the_monitor() {
        let monitor = rect(0, 0, 1920, 1080);
        let card = rect(1000, 300, 1440, 536); // 440 x 236 at 100 %
                                               // The destination rows and a caption: taller, same top.
        assert_eq!(
            card_fit(card, monitor, 330.0, 1.0),
            rect(1000, 300, 1440, 630)
        );
        // Never shorter than usual, never taller than the cap.
        assert_eq!(card_fit(card, monitor, 100.0, 1.0), card);
        assert_eq!(card_fit(card, monitor, 2000.0, 1.0).height(), 560);
        // Near the bottom of the screen it moves up to fit.
        let low = rect(1000, 900, 1440, 1136);
        assert_eq!(
            card_fit(low, monitor, 330.0, 1.0),
            rect(1000, 750, 1440, 1080)
        );
        // At 150 % the CSS pixels are scaled.
        assert_eq!(card_fit(card, monitor, 300.0, 1.5).height(), 450);
    }

    #[test]
    fn overlays_lose_the_title_bar_and_keep_everything_else() {
        // What tao gives an undecorated window: caption, system menu, min/max boxes.
        let tao = WINDOW_STYLE(
            WS_CAPTION.0 | WS_SYSMENU.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0 | WS_CLIPSIBLINGS.0,
        );
        let style = frameless(WINDOW_STYLE(tao.0 | WS_VISIBLE.0));
        assert_eq!(style.0 & FRAME_STYLES.0, 0, "no caption, frame or buttons");
        assert_ne!(style.0 & WS_POPUP.0, 0);
        assert_ne!(style.0 & WS_VISIBLE.0, 0, "other styles stay");
        assert_ne!(style.0 & WS_CLIPSIBLINGS.0, 0, "other styles stay");
        assert_eq!(
            frameless(style),
            style,
            "already frameless: nothing changes"
        );
    }

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
