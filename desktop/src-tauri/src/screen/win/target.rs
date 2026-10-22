//! What to capture: the foreground window, or the monitor under the cursor, plus the little we
//! need to know about it (executable name, where it is, its monitor's DPI).

use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, HMONITOR, MONITORINFO,
    MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindowLongW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, GA_ROOT, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

use crate::screen::frame::{ScreenRect, TargetKind};

/// A capture target, resolved at the moment the user asked.
#[derive(Debug, Clone)]
pub struct Target {
    pub kind: TargetKind,
    /// Set for window targets.
    pub window: Option<HWND>,
    pub monitor: HMONITOR,
    pub bounds: ScreenRect,
    pub monitor_rect: ScreenRect,
    pub dpi: u32,
    /// The app in front (for window targets, that window's app), lowercase file name only.
    pub app: Option<String>,
}

// SAFETY: HWND and HMONITOR are plain handles (opaque numbers), valid from any thread; the
// capture worker only passes them back to Windows, which checks them.
unsafe impl Send for Target {}

/// The window the user is working in, or None (desktop, taskbar, our own windows).
pub fn foreground_app_window() -> Option<HWND> {
    // SAFETY: no arguments; returns a handle or null.
    let hwnd = unsafe { GetForegroundWindow() };
    let root = root_of(hwnd)?;
    if is_app_window(root) {
        return Some(root);
    }
    // The tray menu (or the taskbar) is in front when "Look at my screen" is clicked: use the
    // topmost ordinary window instead, which is what the user was looking at.
    topmost_app_window()
}

/// The foreground window, falling back to the monitor under the cursor.
pub fn ask_target() -> Option<Target> {
    match foreground_app_window() {
        Some(hwnd) => window_target(hwnd).or_else(monitor_target),
        None => monitor_target(),
    }
}

/// The whole monitor under the cursor (coach mode, decision 6).
pub fn monitor_target() -> Option<Target> {
    let mut point = POINT::default();
    // SAFETY: `point` is a valid out pointer for the duration of the call.
    unsafe { GetCursorPos(&mut point) }.ok()?;
    // SAFETY: plain value arguments.
    let monitor = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) };
    let monitor_rect = monitor_rect(monitor)?;
    let app = foreground_app_window().and_then(exe_name_of);
    Some(Target {
        kind: TargetKind::Monitor,
        window: None,
        monitor,
        bounds: monitor_rect,
        monitor_rect,
        dpi: monitor_dpi(monitor),
        app,
    })
}

pub fn window_target(hwnd: HWND) -> Option<Target> {
    let bounds = window_bounds(hwnd)?;
    if bounds.width() <= 0 || bounds.height() <= 0 {
        return None;
    }
    // SAFETY: plain value arguments; Windows validates the handle.
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let monitor_rect = monitor_rect(monitor)?;
    Some(Target {
        kind: TargetKind::Window,
        window: Some(hwnd),
        monitor,
        bounds,
        monitor_rect,
        dpi: monitor_dpi(monitor),
        app: exe_name_of(hwnd),
    })
}

fn root_of(hwnd: HWND) -> Option<HWND> {
    if hwnd.is_invalid() {
        return None;
    }
    // SAFETY: plain value arguments; returns null for invalid handles.
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    (!root.is_invalid()).then_some(root)
}

/// An ordinary, visible app window that isn't ours or part of the Windows shell.
fn is_app_window(hwnd: HWND) -> bool {
    // SAFETY: plain value arguments throughout; Windows validates the handle.
    let visible =
        unsafe { IsWindowVisible(hwnd) }.as_bool() && !unsafe { IsIconic(hwnd) }.as_bool();
    if !visible || is_cloaked(hwnd) {
        return false;
    }
    // SAFETY: as above.
    let ex_style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32;
    if ex_style & WS_EX_TOOLWINDOW.0 != 0 {
        return false;
    }
    let mut pid = 0u32;
    // SAFETY: `pid` is a valid out pointer for the duration of the call.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    // SAFETY: no arguments.
    if pid == 0 || pid == unsafe { GetCurrentProcessId() } {
        return false;
    }
    !class_name(hwnd).is_some_and(|class| is_shell_class(&class))
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    // SAFETY: the out buffer is a u32, and we pass its exact size.
    let result = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            (&mut cloaked as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    };
    result.is_ok() && cloaked != 0
}

fn class_name(hwnd: HWND) -> Option<String> {
    let mut buffer = [0u16; 256];
    // SAFETY: the buffer is valid and its length is passed with it.
    let len = unsafe { GetClassNameW(hwnd, &mut buffer) };
    (len > 0).then(|| String::from_utf16_lossy(&buffer[..len as usize]))
}

/// Windows shell surfaces that are never "the app the user is working in".
pub fn is_shell_class(class: &str) -> bool {
    matches!(
        class,
        "Progman"
            | "WorkerW"
            | "Shell_TrayWnd"
            | "Shell_SecondaryTrayWnd"
            | "NotifyIconOverflowWindow"
            | "TopLevelWindowForOverflowXamlIsland"
            | "Xaml_WindowedPopupClass"
            | "#32768" // menus
    )
}

/// The topmost ordinary app window (EnumWindows goes from top to bottom of the z-order).
fn topmost_app_window() -> Option<HWND> {
    let mut found: Option<HWND> = None;
    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        // SAFETY: `lparam` is the address of `found` below, alive for the whole EnumWindows call.
        let found = unsafe { &mut *(lparam.0 as *mut Option<HWND>) };
        if is_app_window(hwnd) {
            *found = Some(hwnd);
            return false.into(); // stop
        }
        true.into()
    }
    // SAFETY: the callback only runs during this call, while `found` is alive. EnumWindows
    // reports an error when the callback stops it early; that's expected.
    let _ = unsafe {
        EnumWindows(
            Some(visit),
            LPARAM(&mut found as *mut Option<HWND> as isize),
        )
    };
    found
}

/// The window's visible bounds (without the invisible resize borders Windows adds).
fn window_bounds(hwnd: HWND) -> Option<ScreenRect> {
    let mut rect = RECT::default();
    // SAFETY: the out buffer is a RECT, and we pass its exact size.
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&mut rect as *mut RECT).cast(),
            std::mem::size_of::<RECT>() as u32,
        )
    }
    .ok()?;
    Some(to_rect(rect))
}

fn monitor_rect(monitor: HMONITOR) -> Option<ScreenRect> {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: `info` is valid and its cbSize is set, as the function requires.
    unsafe { GetMonitorInfoW(monitor, &mut info) }
        .as_bool()
        .then(|| to_rect(info.rcMonitor))
}

fn monitor_dpi(monitor: HMONITOR) -> u32 {
    let (mut x, mut y) = (0u32, 0u32);
    // SAFETY: both out pointers are valid for the duration of the call.
    match unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut x, &mut y) } {
        Ok(()) if x > 0 => x,
        _ => 96,
    }
}

fn to_rect(rect: RECT) -> ScreenRect {
    ScreenRect {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    }
}

/// The executable name (no path: paths contain user names) of a window's process.
pub fn exe_name_of(hwnd: HWND) -> Option<String> {
    let mut pid = 0u32;
    // SAFETY: `pid` is a valid out pointer for the duration of the call.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return None;
    }
    // SAFETY: requests the least access that can read the image name; the handle is closed below.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buffer = [0u16; 1024];
    let mut len = buffer.len() as u32;
    // SAFETY: the buffer and its length in characters are passed together.
    let result = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
    };
    // SAFETY: `process` was opened above and is closed exactly once.
    let _ = unsafe { CloseHandle(process) };
    result.ok()?;
    exe_basename(&String::from_utf16_lossy(&buffer[..len as usize]))
}

/// "C:\Users\me\AppData\Local\App\App.EXE" → "app.exe".
pub fn exe_basename(path: &str) -> Option<String> {
    let name = path.rsplit(['\\', '/']).next()?.trim();
    (!name.is_empty()).then(|| name.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_lowercase_file_name() {
        assert_eq!(
            exe_basename(r"C:\Users\alice\AppData\Local\1Password\app\8\1Password.EXE").as_deref(),
            Some("1password.exe")
        );
        assert_eq!(exe_basename("EXCEL.EXE").as_deref(), Some("excel.exe"));
        assert_eq!(exe_basename(r"C:\dir\"), None);
        assert_eq!(exe_basename(""), None);
    }

    #[test]
    fn knows_the_shell_surfaces() {
        assert!(is_shell_class("Shell_TrayWnd"));
        assert!(is_shell_class("Progman"));
        assert!(is_shell_class("#32768"));
        assert!(!is_shell_class("XLMAIN"));
        assert!(!is_shell_class("Chrome_WidgetWin_1"));
    }
}
