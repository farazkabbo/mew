//! The capture indicator: a brief violet glow around the edges of the monitor that was just
//! captured (brief §7.1: visible every time a screenshot is taken).
//!
//! Four thin native windows (one per edge): click-through, topmost, never focused, hidden from
//! Alt+Tab, and excluded from every capture, ours and screen shares alike. They fade out and
//! are destroyed; nothing stays running between captures.

use std::sync::Once;
use std::time::Duration;

use windows::core::w;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{CreateSolidBrush, GetSysColor, COLOR_HIGHLIGHT, HBRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW,
    RegisterClassExW, SetLayeredWindowAttributes, SetWindowDisplayAffinity, ShowWindow,
    SystemParametersInfoW, TranslateMessage, LWA_ALPHA, MSG, PM_REMOVE, SPI_GETCLIENTAREAANIMATION,
    SPI_GETHIGHCONTRAST, SW_SHOWNOACTIVATE, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    WDA_EXCLUDEFROMCAPTURE, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

use crate::screen::frame::ScreenRect;

/// The tutor's ink colour (#8a7bf0) as a COLORREF (0x00BBGGRR).
const TUTOR_VIOLET: COLORREF = COLORREF(0x00F0_7B8A);
const THICKNESS_AT_100: i32 = 4;
const PEAK_ALPHA: u8 = 220;
const FADE_STEPS: u32 = 12;
const HOLD: Duration = Duration::from_millis(250);
const FADE: Duration = Duration::from_millis(450);

static REGISTER: Once = Once::new();

/// Flashes the edges of `monitor` (non-blocking: runs on its own short-lived thread).
pub fn flash(monitor: ScreenRect, dpi: u32) {
    let spawned = std::thread::Builder::new()
        .name("mew-capture-indicator".into())
        .spawn(move || {
            if let Err(error) = run(monitor, dpi) {
                eprintln!("[screen] capture indicator failed ({:#x})", error.code().0);
            }
        });
    if spawned.is_err() {
        eprintln!("[screen] couldn't start the capture indicator");
    }
}

/// Edge strips for a monitor: top, bottom, left, right (left/right between the other two).
pub fn edge_strips(monitor: ScreenRect, dpi: u32) -> [ScreenRect; 4] {
    let t = (THICKNESS_AT_100 * dpi.max(96) as i32 / 96).max(2);
    let ScreenRect {
        left,
        top,
        right,
        bottom,
    } = monitor;
    [
        ScreenRect {
            left,
            top,
            right,
            bottom: top + t,
        },
        ScreenRect {
            left,
            top: bottom - t,
            right,
            bottom,
        },
        ScreenRect {
            left,
            top: top + t,
            right: left + t,
            bottom: bottom - t,
        },
        ScreenRect {
            left: right - t,
            top: top + t,
            right,
            bottom: bottom - t,
        },
    ]
}

/// Alpha for each fade step, from the peak down to zero.
pub fn fade_alphas(steps: u32) -> Vec<u8> {
    (1..=steps)
        .map(|i| (u32::from(PEAK_ALPHA) * (steps - i) / steps) as u8)
        .collect()
}

fn run(monitor: ScreenRect, dpi: u32) -> windows::core::Result<()> {
    let colour = if high_contrast() {
        // SAFETY: reads a system colour; no pointers.
        COLORREF(unsafe { GetSysColor(COLOR_HIGHLIGHT) })
    } else {
        TUTOR_VIOLET
    };
    // SAFETY: GetModuleHandleW(None) returns this executable's module handle.
    let instance = unsafe { GetModuleHandleW(None) }?;
    REGISTER.call_once(|| {
        // SAFETY: the class name is a static string and the window procedure is a valid
        // `extern "system"` function; registering twice is prevented by `Once`.
        unsafe {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(window_proc),
                hInstance: instance.into(),
                lpszClassName: w!("MewCaptureIndicator"),
                ..Default::default()
            };
            RegisterClassExW(&class);
        }
    });
    // SAFETY: the brush is used as the background of windows destroyed below; it's a small GDI
    // object reclaimed at process exit (one per capture is negligible but we still free it).
    let brush = unsafe { CreateSolidBrush(colour) };

    let mut windows = Vec::with_capacity(4);
    for strip in edge_strips(monitor, dpi) {
        // SAFETY: creating a top-level popup on this thread with a registered class; the
        // handle is destroyed at the end of this function on the same thread.
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_LAYERED
                    | WS_EX_TRANSPARENT
                    | WS_EX_TOPMOST
                    | WS_EX_TOOLWINDOW
                    | WS_EX_NOACTIVATE,
                w!("MewCaptureIndicator"),
                w!(""),
                WS_POPUP,
                strip.left,
                strip.top,
                strip.width(),
                strip.height(),
                None,
                None,
                Some(instance.into()),
                None,
            )
        }?;
        windows.push(hwnd);
        // SAFETY: `hwnd` is a top-level window this process owns, as both calls require.
        unsafe {
            // Never in any capture: ours or the user's screen share (Windows 10 2004+).
            SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)?;
            SetClassBackground(hwnd, brush);
            SetLayeredWindowAttributes(hwnd, COLORREF(0), PEAK_ALPHA, LWA_ALPHA)?;
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
    }

    pump_for(HOLD);
    if animations_enabled() {
        for alpha in fade_alphas(FADE_STEPS) {
            for &hwnd in &windows {
                // SAFETY: windows created above, still alive.
                let _ = unsafe { SetLayeredWindowAttributes(hwnd, COLORREF(0), alpha, LWA_ALPHA) };
            }
            pump_for(FADE / FADE_STEPS);
        }
    } else {
        // "Show animations" is off: no fade, just a steady glow for the same total time.
        pump_for(FADE);
    }
    for hwnd in windows {
        // SAFETY: windows created above on this thread, destroyed once.
        let _ = unsafe { DestroyWindow(hwnd) };
    }
    // SAFETY: the windows using the brush are gone.
    let _ = unsafe { windows::Win32::Graphics::Gdi::DeleteObject(brush.into()) };
    Ok(())
}

/// Paints with `brush` by setting it as the window class background for this window.
///
/// SAFETY: `hwnd` must be a live window of this process.
#[allow(non_snake_case)]
unsafe fn SetClassBackground(hwnd: HWND, brush: HBRUSH) {
    use windows::Win32::UI::WindowsAndMessaging::{SetClassLongPtrW, GCLP_HBRBACKGROUND};
    // SAFETY: per the function contract; the brush outlives the window.
    unsafe { SetClassLongPtrW(hwnd, GCLP_HBRBACKGROUND, brush.0 as isize) };
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: default handling for our own windows.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// Handles this thread's window messages (painting) for `duration`.
fn pump_for(duration: Duration) {
    let until = std::time::Instant::now() + duration;
    let mut msg = MSG::default();
    while std::time::Instant::now() < until {
        // SAFETY: standard message pump for windows owned by this thread.
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Windows Settings → Accessibility → Visual effects → "Animation effects".
fn animations_enabled() -> bool {
    let mut enabled = windows::core::BOOL(1);
    // SAFETY: SPI_GETCLIENTAREAANIMATION writes a BOOL to the pointer.
    let result = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some((&mut enabled as *mut windows::core::BOOL).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    result.is_err() || enabled.as_bool()
}

/// A contrast theme is on: use the system highlight colour instead of our violet.
fn high_contrast() -> bool {
    let mut info = HIGHCONTRASTW {
        cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32,
        ..Default::default()
    };
    // SAFETY: `info` is valid with cbSize set, as SPI_GETHIGHCONTRAST requires.
    let result = unsafe {
        SystemParametersInfoW(
            SPI_GETHIGHCONTRAST,
            info.cbSize,
            Some((&mut info as *mut HIGHCONTRASTW).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    result.is_ok() && info.dwFlags.0 & HCF_HIGHCONTRASTON.0 != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_hug_the_edges_at_any_scaling_and_position() {
        // A 150 % monitor left of the primary (negative coordinates).
        let monitor = ScreenRect {
            left: -2560,
            top: -200,
            right: 0,
            bottom: 1240,
        };
        let [top, bottom, left, right] = edge_strips(monitor, 144);
        assert_eq!(
            top,
            ScreenRect {
                left: -2560,
                top: -200,
                right: 0,
                bottom: -194
            }
        );
        assert_eq!(
            bottom,
            ScreenRect {
                left: -2560,
                top: 1234,
                right: 0,
                bottom: 1240
            }
        );
        assert_eq!(
            left,
            ScreenRect {
                left: -2560,
                top: -194,
                right: -2554,
                bottom: 1234
            }
        );
        assert_eq!(
            right,
            ScreenRect {
                left: -6,
                top: -194,
                right: 0,
                bottom: 1234
            }
        );
        assert_eq!(edge_strips(monitor, 96)[0].height(), 4);
        assert_eq!(edge_strips(monitor, 192)[0].height(), 8);
    }

    #[test]
    fn fades_from_peak_to_nothing() {
        let alphas = fade_alphas(4);
        assert_eq!(alphas, vec![165, 110, 55, 0]);
        assert!(alphas.windows(2).all(|w| w[0] > w[1]));
    }
}
