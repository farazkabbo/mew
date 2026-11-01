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
//! - The island (Screen Coach's tools, at the top of the screen) is clickable but never focused,
//!   like the progress pill, and excluded from captures.
//! - The preview is an ordinary focused window: the only WebView that ever sees screen pixels,
//!   and only for a clip the student asked to save (decision 2, S3 §5).
//!
//! The overlays stay out of screen shares and recordings unless the student turns on "Show Neb in
//! screen shares and recordings"; Neb's own captures leave them out either way.
//!
//! Windows are created on first use (off the main thread: building a window from the main
//! thread can deadlock on Windows) and kept hidden between uses.

use std::any::Any;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::Value;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::DwmFlush;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, IsWindowVisible, SetForegroundWindow, SetWindowDisplayAffinity,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, GWL_STYLE, HWND_TOPMOST,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE,
    SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE, WDA_NONE, WINDOW_DISPLAY_AFFINITY, WINDOW_STYLE,
    WS_CAPTION, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT, WS_MAXIMIZEBOX, WS_MINIMIZEBOX,
    WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
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
    /// The island: Screen Coach's tools in a bar at the top of the screen (`screen_island.rs`).
    Island,
    /// "neb sees your screen only while this frame is on" (`status.rs`, U8).
    Capsule,
    /// The held Ctrl+Alt keys, with Screen Coach off or paused (`status.rs`, U8).
    Keys,
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
    /// Every overlay kept out of captures (the preview is an ordinary window, in them already).
    const OVERLAYS: [Surface; 11] = [
        Surface::Ink,
        Surface::Pill,
        Surface::Notes,
        Surface::Coach,
        Surface::Pointer,
        Surface::Draw,
        Surface::Card,
        Surface::Quiz,
        Surface::Island,
        Surface::Capsule,
        Surface::Keys,
    ];

    /// The overlays that can paint an empty white box while hidden (seen with the card once the
    /// student showed Neb in captures; Windows still called it hidden). They take the focus when
    /// clicked, so they aren't made like the rest, and each is placed whenever it's shown.
    const fn parks(self) -> bool {
        matches!(self, Surface::Card | Surface::Quiz | Surface::Notes)
    }

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
            Surface::Island => "screen-island",
            Surface::Capsule => "screen-capsule",
            Surface::Keys => "screen-keys",
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
            Surface::Island => "island.html",
            Surface::Capsule => "capsule.html",
            Surface::Keys => "keys-hint.html",
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
        // Like the progress pill: clicked, never focused (the student's app keeps the keyboard).
        Surface::Island => builder
            .title("Neb")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .focusable(false)
            .inner_size(super::island::ISLAND_SIZE.0, super::island::ISLAND_SIZE.1),
        // Notices: shown, never clicked or focused (`status.rs`).
        Surface::Capsule | Surface::Keys => builder
            .title("Neb")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .focusable(false)
            .inner_size(
                if surface == Surface::Capsule {
                    super::status::CAPSULE_SIZE.0
                } else {
                    super::status::KEYS_SIZE.0
                },
                if surface == Surface::Capsule {
                    super::status::CAPSULE_SIZE.1
                } else {
                    super::status::KEYS_SIZE.1
                },
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
    // Click-through until told otherwise (the draw overlay, while the student draws; the island
    // once it shows: it's made like the draw overlay so its webview is truly transparent around
    // its shape, and clicks on those clear pixels reach the app below).
    if matches!(
        surface,
        Surface::Ink
            | Surface::Pointer
            | Surface::Draw
            | Surface::Island
            | Surface::Capsule
            | Surface::Keys
    ) {
        let _ = window.set_ignore_cursor_events(true);
    }
    if surface != Surface::Clip {
        // Nothing else sets it while the window stays hidden.
        if let Ok(hwnd) = window.hwnd() {
            let raw = hwnd.0 as isize;
            let _ = window.run_on_main_thread(move || match_capture_choice(HWND(raw as *mut _)));
        }
    }
    if surface != Surface::Clip {
        no_title_bar(&window);
    }
    if surface.parks() {
        park(&window);
    }
    Some(window)
}

/// Each overlay's window procedure before ours (window handle, procedure).
static PREVIOUS_PROCS: std::sync::Mutex<Vec<(isize, isize)>> = std::sync::Mutex::new(Vec::new());

fn previous_proc(hwnd: HWND) -> isize {
    let procs = PREVIOUS_PROCS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    procs
        .iter()
        .find(|(window, _)| *window == hwnd.0 as isize)
        .map_or(0, |(_, previous)| *previous)
}

/// Keeps an overlay's whole area for its page, whatever styles it's given. Windows reserves room
/// for a title bar and frame (the "non-client area") from the window's styles, which tao writes
/// back whenever its own settings change; that room showed as a white band along the top (of
/// the draw overlay, over the island, when a tool came on). Answering WM_NCCALCSIZE with "no
/// room" means there's never any non-client area, and nothing of it is ever painted.
fn no_title_bar<R: Runtime>(window: &WebviewWindow<R>) {
    use windows::Win32::UI::WindowsAndMessaging::GWLP_WNDPROC;
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let raw = hwnd.0 as isize;
    let _ = window.run_on_main_thread(move || {
        let hwnd = HWND(raw as *mut _);
        // SAFETY: a window of this process, on its own thread. The previous procedure is kept
        // (and called for everything else) before ours is set; it stays valid for the window's
        // life, which ends with the app.
        unsafe {
            if previous_proc(hwnd) != 0 {
                return;
            }
            let previous = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
            PREVIOUS_PROCS
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((raw, previous));
            SetWindowLongPtrW(hwnd, GWLP_WNDPROC, overlay_proc as *const () as isize);
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
    });
}

/// An overlay's window procedure: no non-client area, ever; everything else as before.
unsafe extern "system" fn overlay_proc(
    hwnd: HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, WM_NCACTIVATE, WM_NCCALCSIZE, WM_NCPAINT, WNDPROC,
    };
    match msg {
        // The client area is the whole window.
        WM_NCCALCSIZE if wparam.0 != 0 => return LRESULT(0),
        // Nothing outside it to paint.
        WM_NCPAINT => return LRESULT(0),
        WM_NCACTIVATE => return LRESULT(1),
        _ => {}
    }
    let previous = previous_proc(hwnd);
    // SAFETY: `previous` is the window's own procedure, saved when ours was set; a WNDPROC is
    // a nullable function pointer the same size as isize.
    unsafe {
        if previous == 0 {
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        let previous: WNDPROC = std::mem::transmute::<isize, WNDPROC>(previous);
        CallWindowProcW(previous, hwnd, msg, wparam, lparam)
    }
}

/// The student chose to show the overlays in screen shares and recordings.
static SHOW_IN_CAPTURES: AtomicBool = AtomicBool::new(false);
/// Neb's own captures under way: the overlays are out of the picture for them, whatever was chosen.
static OWN_CAPTURES: AtomicUsize = AtomicUsize::new(0);
/// How long a capture waits for the overlays to leave the picture before going ahead.
const HIDE_TIMEOUT: Duration = Duration::from_millis(300);

/// What Windows is told about an overlay. Hidden unless the student chose to show it and Neb isn't
/// taking its own picture this moment.
fn capture_affinity(show: bool, own_captures: usize) -> WINDOW_DISPLAY_AFFINITY {
    if show && own_captures == 0 {
        WDA_NONE
    } else {
        WDA_EXCLUDEFROMCAPTURE
    }
}

/// Gives a window the current choice. Call on the thread that owns it.
fn match_capture_choice(hwnd: HWND) {
    let affinity = capture_affinity(
        SHOW_IN_CAPTURES.load(Ordering::SeqCst),
        OWN_CAPTURES.load(Ordering::SeqCst),
    );
    // SAFETY: a top-level window of this process, on the thread that owns it.
    if unsafe { SetWindowDisplayAffinity(hwnd, affinity) }.is_err() {
        eprintln!("[screen] couldn't set an overlay's capture setting");
    }
}

/// Applies the current choice to the overlays on screen. Hidden ones are left alone until they're
/// shown (`show_quietly`, `show_filled`): changing the setting on a hidden, never-placed overlay is
/// the suspected cause of its empty window appearing as a white box. The choice is read on the
/// owning thread, so the last call leaves the windows matching the latest state.
fn apply_capture_affinity<R: Runtime>(app: &AppHandle<R>, done: Option<mpsc::Sender<()>>) {
    let windows: Vec<isize> = Surface::OVERLAYS
        .iter()
        .filter_map(|surface| app.get_webview_window(surface.label())?.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize)
        .collect();
    let _ = app.run_on_main_thread(move || {
        for raw in windows {
            let hwnd = HWND(raw as *mut _);
            // SAFETY: a window of this process; no pointers.
            if unsafe { IsWindowVisible(hwnd) }.as_bool() {
                match_capture_choice(hwnd);
            }
        }
        if let Some(done) = done {
            let _ = done.send(());
        }
    });
}

/// Shows the overlays in screen shares and recordings, or keeps them out (the student's setting).
pub fn set_shown_in_captures<R: Runtime>(app: &AppHandle<R>, show: bool) {
    SHOW_IN_CAPTURES.store(show, Ordering::SeqCst);
    apply_capture_affinity(app, None);
}

/// Keeps the overlays out of Neb's own picture while it's alive. Their ink, cards and tools would
/// otherwise reach the model and the saved clip when the student shows them in screen shares.
struct OwnCapture<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Drop for OwnCapture<R> {
    fn drop(&mut self) {
        OWN_CAPTURES.fetch_sub(1, Ordering::SeqCst);
        apply_capture_affinity(&self.0, None);
    }
}

/// Call off the main thread, before reading pixels; returns once the overlays have left the
/// picture. Does nothing while they're hidden anyway.
pub fn hide_for_own_capture<R: Runtime>(app: &AppHandle<R>) -> Option<Box<dyn Any>> {
    if !SHOW_IN_CAPTURES.load(Ordering::SeqCst) {
        return None;
    }
    OWN_CAPTURES.fetch_add(1, Ordering::SeqCst);
    let guard = OwnCapture(app.clone());
    let (done, applied) = mpsc::channel();
    apply_capture_affinity(app, Some(done));
    let _ = applied.recv_timeout(HIDE_TIMEOUT);
    // The change shows from the next composed frame on: wait until that one's on screen.
    for _ in 0..2 {
        // SAFETY: no arguments; waits for the desktop compositor's next pass.
        let _ = unsafe { DwmFlush() };
    }
    Some(Box::new(guard))
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
        match_capture_choice(hwnd);
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

/// Shows an overlay at `rect` (physical pixels) without activating it, its page filling the
/// whole window. The title bar tao leaves on undecorated windows is taken off first, and the
/// window is then sized (one pixel taller, then exact) so its webview is laid out again over
/// the space the title bar had: otherwise that band stays the window's plain background (seen
/// as a pale strip along the top of the island).
pub fn show_filled<R: Runtime>(window: &WebviewWindow<R>, rect: ScreenRect) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let raw = hwnd.0 as isize;
    let _ = window.run_on_main_thread(move || {
        let hwnd = HWND(raw as *mut _);
        match_capture_choice(hwnd);
        strip_frame(hwnd);
        let (w, h) = (rect.width().max(1), rect.height().max(1));
        // SAFETY: a window of this process, on its own thread; no pointers.
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                rect.left,
                rect.top,
                w,
                h + 1,
                SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                rect.left,
                rect.top,
                w,
                h,
                SWP_NOACTIVATE,
            );
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            log_client_area(hwnd);
        }
    });
}

/// Says whether a window's page has all of it (a title bar's room shows as a band otherwise).
fn log_client_area(hwnd: HWND) {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetWindowRect};
    let (mut window, mut client) = (RECT::default(), RECT::default());
    // SAFETY: a window of this process; the rects are ours to fill.
    let read = unsafe {
        GetWindowRect(hwnd, &raw mut window).is_ok() && GetClientRect(hwnd, &raw mut client).is_ok()
    };
    if read {
        eprintln!(
            "[screen] overlay window {}x{}, page {}x{}",
            window.right - window.left,
            window.bottom - window.top,
            client.right - client.left,
            client.bottom - client.top
        );
    }
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

/// Limits a window to its top `height` physical pixels, without resizing it. What's cut off is no
/// longer part of the window for any input: a pen isn't always passed through clear pixels the way
/// a mouse is, so it couldn't reach what's under the island's empty space.
pub fn keep_top<R: Runtime>(window: &WebviewWindow<R>, width: i32, height: i32) {
    use windows::Win32::Graphics::Gdi::{CreateRectRgn, SetWindowRgn};
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let raw = hwnd.0 as isize;
    let _ = window.run_on_main_thread(move || {
        // SAFETY: a window of this process, on its own thread. Windows owns the region once it's
        // set, so it isn't freed here.
        unsafe {
            let region = CreateRectRgn(0, 0, width, height);
            SetWindowRgn(HWND(raw as *mut _), Some(region), true);
        }
    });
}

/// Turns off Windows 11's own border and rounded corners on an overlay drawn as a shape by its
/// page (the island): without this a pale frame shows around it.
pub fn drop_frame<R: Runtime>(window: &WebviewWindow<R>) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let raw = hwnd.0 as isize;
    let _ = window.run_on_main_thread(move || {
        let hwnd = HWND(raw as *mut _);
        // SAFETY: a window of this process, on its own thread; the attribute values outlive the
        // calls.
        unsafe {
            let corners = DWMWCP_DONOTROUND;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                (&raw const corners).cast(),
                std::mem::size_of_val(&corners) as u32,
            );
            let none = DWMWA_COLOR_NONE;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_BORDER_COLOR,
                (&raw const none).cast(),
                std::mem::size_of_val(&none) as u32,
            );
        }
    });
}

/// Off every monitor, in physical pixels. (A builder's `position` is scaled by the display's DPI,
/// which puts this outside what Windows accepts, and the window lands at its default spot.)
const PARKED_AT: i32 = -32000;

/// Moves a hidden overlay off every monitor, on its own thread.
fn park<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let raw = hwnd.0 as isize;
    let _ = window.run_on_main_thread(move || {
        // SAFETY: a window of this process, on its own thread; no pointers.
        let _ = unsafe {
            SetWindowPos(
                HWND(raw as *mut _),
                None,
                PARKED_AT,
                PARKED_AT,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            )
        };
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
    if Surface::OVERLAYS
        .iter()
        .any(|surface| surface.parks() && surface.label() == window.label())
    {
        park(window);
    }
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

    #[test]
    fn overlays_are_hidden_unless_chosen_and_always_from_nebs_own_picture() {
        assert_eq!(capture_affinity(false, 0), WDA_EXCLUDEFROMCAPTURE);
        assert_eq!(capture_affinity(true, 0), WDA_NONE);
        assert_eq!(capture_affinity(true, 1), WDA_EXCLUDEFROMCAPTURE);
        assert_eq!(capture_affinity(false, 2), WDA_EXCLUDEFROMCAPTURE);
    }
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
