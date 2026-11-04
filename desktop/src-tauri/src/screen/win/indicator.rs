//! The capture indicator: violet edges around a monitor (brief §7.1: visible every time a
//! screenshot is taken), as a brief glow after a capture (`flash`) or held for as long as neb can
//! capture (`Frame`, NEB_APP_UI §5.4: the coach frame).
//!
//! Four thin native windows (one per edge): click-through, topmost, never focused, hidden from
//! Alt+Tab, and excluded from every capture, ours and screen shares alike. They fade out and
//! are destroyed; nothing stays running when no frame is held.
//!
//! A capture needs a `FrameToken`, which only a `Frame` that is on screen lends: the pipeline's
//! capture takes one, so no capture happens while the frame is off (decision U9).

use std::marker::PhantomData;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Once};
use std::time::Duration;

use windows::core::w;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{CreateSolidBrush, GetSysColor, COLOR_HIGHLIGHT, HBRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW,
    RegisterClassExW, SetLayeredWindowAttributes, SetWindowDisplayAffinity, ShowWindow,
    TranslateMessage, LWA_ALPHA, MSG, PM_REMOVE, SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE,
    WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_EX_TRANSPARENT, WS_POPUP,
};

use super::system;
use crate::screen::frame::ScreenRect;

/// neb's violet (#6b4ee6, `--neb` in packages/shared/src/ui/tokens.ts) as a COLORREF (0x00BBGGRR).
const TUTOR_VIOLET: COLORREF = COLORREF(0x00E6_4E6B);
const THICKNESS_AT_100: i32 = 4;
const PEAK_ALPHA: u8 = 220;
const FADE_STEPS: u32 = 12;
const HOLD: Duration = Duration::from_millis(250);
const FADE: Duration = Duration::from_millis(450);
/// A held frame fades within this when it's let go (§5.4).
const HELD_FADE: Duration = Duration::from_millis(150);
const HELD_FADE_STEPS: u32 = 6;
/// The held frame's inner glow: this deep at 100 % scaling, at most this alpha (33 %), in bands.
const GLOW_AT_100: i32 = 40;
const GLOW_ALPHA: u8 = 84;
const GLOW_BANDS: u32 = 4;
/// How long `Frame::hold` waits for the edges to be on screen before giving up. 300 ms was
/// often too short on a busy PC (a screen recorder running, a debug build): the capture was refused
/// and the student's marks vanished.
const SHOW_TIMEOUT: Duration = Duration::from_millis(2000);

static REGISTER: Once = Once::new();

/// How long the edges stay before they fade.
enum Keep {
    /// A flash: a moment, then the slow fade.
    Briefly,
    /// A held frame: until the flag is set, then the quick fade.
    Until(Arc<AtomicBool>),
}

/// Flashes the edges of `monitor` (non-blocking: runs on its own short-lived thread).
pub fn flash(monitor: ScreenRect, dpi: u32) {
    if !spawn(monitor, dpi, Keep::Briefly, None) {
        eprintln!("[screen] couldn't start the capture indicator");
    }
}

/// The frame held on a monitor while neb can capture it. Dropping it lets go: the edges fade
/// within 150 ms.
pub struct Frame {
    monitor: ScreenRect,
    stop: Arc<AtomicBool>,
}

/// Proof that a frame is on screen, for as long as it's borrowed: what a capture requires.
pub struct FrameToken<'a>(PhantomData<&'a Frame>);

impl Frame {
    /// Shows the frame on `monitor` and returns once it's on screen, or None if it couldn't be
    /// shown (then nothing may be captured).
    pub fn hold(monitor: ScreenRect, dpi: u32) -> Option<Frame> {
        let stop = Arc::new(AtomicBool::new(false));
        let (shown, on_screen) = mpsc::channel();
        if !spawn(monitor, dpi, Keep::Until(Arc::clone(&stop)), Some(shown)) {
            return None;
        }
        match on_screen.recv_timeout(SHOW_TIMEOUT) {
            Ok(true) => Some(Frame { monitor, stop }),
            _ => {
                stop.store(true, Ordering::SeqCst);
                None
            }
        }
    }

    /// The monitor it's on.
    pub fn monitor(&self) -> ScreenRect {
        self.monitor
    }

    /// Lends the proof that it's on screen.
    pub fn token(&self) -> FrameToken<'_> {
        FrameToken(PhantomData)
    }
}

impl Drop for Frame {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Runs the edges on their own thread. False if the thread couldn't start.
fn spawn(monitor: ScreenRect, dpi: u32, keep: Keep, shown: Option<mpsc::Sender<bool>>) -> bool {
    std::thread::Builder::new()
        .name("mew-capture-indicator".into())
        .spawn(move || {
            if let Err(error) = run(monitor, dpi, keep, shown.as_ref()) {
                eprintln!("[screen] capture indicator failed ({:#x})", error.code().0);
                if let Some(shown) = shown {
                    let _ = shown.send(false);
                }
            }
        })
        .is_ok()
}

/// Edge strips for a monitor: top, bottom, left, right (left/right between the other two).
pub fn edge_strips(monitor: ScreenRect, dpi: u32) -> [ScreenRect; 4] {
    ring(monitor, 0, scaled(THICKNESS_AT_100, dpi))
}

/// The held frame's inner glow (§5.4: 40 px of violet at 33 % inside the edge, fading inwards),
/// as bands inside the edge strips, each with its own alpha.
pub fn glow_strips(monitor: ScreenRect, dpi: u32) -> Vec<(ScreenRect, u8)> {
    let edge = scaled(THICKNESS_AT_100, dpi);
    let band = scaled(GLOW_AT_100 / GLOW_BANDS as i32, dpi);
    (0..GLOW_BANDS)
        .flat_map(|i| {
            let alpha = (u32::from(GLOW_ALPHA) * (GLOW_BANDS - i) / GLOW_BANDS) as u8;
            ring(monitor, edge + band * i as i32, band).map(|strip| (strip, alpha))
        })
        .collect()
}

/// A length at 100 % scaling, in this monitor's pixels (at least 2).
fn scaled(length: i32, dpi: u32) -> i32 {
    (length * dpi.max(96) as i32 / 96).max(2)
}

/// Four strips `t` thick, `inset` in from the monitor's edges.
fn ring(monitor: ScreenRect, inset: i32, t: i32) -> [ScreenRect; 4] {
    let (left, top, right, bottom) = (
        monitor.left + inset,
        monitor.top + inset,
        monitor.right - inset,
        monitor.bottom - inset,
    );
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
    (1..=steps).map(|i| faded(PEAK_ALPHA, i, steps)).collect()
}

/// `peak` after `step` of `steps` fade steps.
fn faded(peak: u8, step: u32, steps: u32) -> u8 {
    (u32::from(peak) * steps.saturating_sub(step) / steps.max(1)) as u8
}

fn run(
    monitor: ScreenRect,
    dpi: u32,
    keep: Keep,
    shown: Option<&mpsc::Sender<bool>>,
) -> windows::core::Result<()> {
    let colour = if system::high_contrast() {
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

    let mut strips: Vec<(ScreenRect, u8)> = edge_strips(monitor, dpi)
        .into_iter()
        .map(|strip| (strip, PEAK_ALPHA))
        .collect();
    if matches!(keep, Keep::Until(_)) {
        strips.extend(glow_strips(monitor, dpi));
    }
    let mut windows = Vec::with_capacity(strips.len());
    for (strip, peak) in strips {
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
        windows.push((hwnd, peak));
        // SAFETY: `hwnd` is a top-level window this process owns, as both calls require.
        unsafe {
            // Never in any capture: ours or the user's screen share (Windows 10 2004+).
            SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)?;
            SetClassBackground(hwnd, brush);
            SetLayeredWindowAttributes(hwnd, COLORREF(0), peak, LWA_ALPHA)?;
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
    }

    pump_for(Duration::ZERO);
    if let Some(shown) = shown {
        let _ = shown.send(true);
    }
    let (fade, steps) = match keep {
        Keep::Briefly => {
            pump_for(HOLD);
            (FADE, FADE_STEPS)
        }
        Keep::Until(stop) => {
            while !stop.load(Ordering::SeqCst) {
                pump_for(Duration::from_millis(16));
            }
            (HELD_FADE, HELD_FADE_STEPS)
        }
    };
    if system::animations_enabled() {
        for step in 1..=steps {
            for &(hwnd, peak) in &windows {
                let alpha = faded(peak, step, steps);
                // SAFETY: windows created above, still alive.
                let _ = unsafe { SetLayeredWindowAttributes(hwnd, COLORREF(0), alpha, LWA_ALPHA) };
            }
            pump_for(fade / steps);
        }
    } else {
        // "Show animations" is off: no fade, just a steady glow for the same total time.
        pump_for(fade);
    }
    for (hwnd, _) in windows {
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
    loop {
        // SAFETY: standard message pump for windows owned by this thread.
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        if std::time::Instant::now() >= until {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
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
    fn the_glow_fades_inwards_inside_the_edge() {
        let monitor = ScreenRect {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        let glow = glow_strips(monitor, 96);
        assert_eq!(glow.len(), 16);
        // Just inside the 4 px edge, 10 px bands down to 40 px in, fainter each band.
        assert_eq!(glow[0].0.top, 4);
        assert_eq!(glow[0].0.height(), 10);
        assert_eq!(glow[12].0.top, 34);
        let alphas: Vec<u8> = glow.iter().step_by(4).map(|(_, a)| *a).collect();
        assert_eq!(alphas, vec![84, 63, 42, 21]);
        // At 150 % it's deeper in pixels, the same in look.
        assert_eq!(glow_strips(monitor, 144)[0].0.height(), 15);
    }

    #[test]
    fn fades_from_peak_to_nothing() {
        let alphas = fade_alphas(4);
        assert_eq!(alphas, vec![165, 110, 55, 0]);
        assert!(alphas.windows(2).all(|w| w[0] > w[1]));
    }
}
