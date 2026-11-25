//! Public metadata APIs only. Discovery is not capture authorization or secure-focus evidence.
use super::{Display, Point, Rect};
use objc2::{class, msg_send, runtime::AnyObject};
use std::ffi::{c_char, c_void, CStr};

type Cf = *const c_void;
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Size {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CgRect {
    origin: Point,
    size: Size,
}
impl CgRect {
    fn checked(self) -> Option<Rect> {
        Rect::new(
            self.origin.x,
            self.origin.y,
            self.size.width,
            self.size.height,
        )
    }
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(id: u32) -> CgRect;
    fn CGDisplayCopyDisplayMode(id: u32) -> Cf;
    fn CGDisplayModeGetPixelWidth(mode: Cf) -> usize;
    fn CGDisplayModeGetPixelHeight(mode: Cf) -> usize;
    fn CGWindowListCopyWindowInfo(options: u32, relative: u32) -> Cf;
    fn CGRectMakeWithDictionaryRepresentation(dictionary: Cf, rect: *mut CgRect) -> bool;
    static kCGWindowNumber: Cf;
    static kCGWindowOwnerPID: Cf;
    static kCGWindowLayer: Cf;
    static kCGWindowBounds: Cf;
    static kCGWindowAlpha: Cf;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Cf);
    fn CFGetTypeID(value: Cf) -> usize;
    fn CFArrayGetTypeID() -> usize;
    fn CFDictionaryGetTypeID() -> usize;
    fn CFNumberGetTypeID() -> usize;
    fn CFArrayGetCount(array: Cf) -> isize;
    fn CFArrayGetValueAtIndex(array: Cf, index: isize) -> Cf;
    fn CFDictionaryGetValue(dictionary: Cf, key: Cf) -> Cf;
    fn CFNumberGetValue(number: Cf, kind: isize, value: *mut c_void) -> bool;
}
#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {}
unsafe extern "C" {
    fn pthread_main_np() -> i32;
}

/// Owns one Create/Copy Core Foundation reference. Never contains a borrowed reference.
struct Owned(Cf);
impl Owned {
    fn new(value: Cf) -> Option<Self> {
        (!value.is_null()).then_some(Self(value))
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}

pub fn displays() -> Option<Vec<Display>> {
    // Query count then fill; a hot-plug race returns None instead of stale/truncated geometry.
    let mut count = 0;
    if unsafe { CGGetActiveDisplayList(0, std::ptr::null_mut(), &mut count) } != 0 || count == 0 {
        return None;
    }
    let mut ids = vec![0; usize::try_from(count).ok()?];
    let capacity = count;
    if unsafe { CGGetActiveDisplayList(capacity, ids.as_mut_ptr(), &mut count) } != 0
        || count > capacity
    {
        return None;
    }
    ids.truncate(count as usize);
    ids.into_iter().map(display).collect()
}

pub fn display(id: u32) -> Option<Display> {
    let points = unsafe { CGDisplayBounds(id) }.checked()?;
    let mode = Owned::new(unsafe { CGDisplayCopyDisplayMode(id) })?;
    let width = u32::try_from(unsafe { CGDisplayModeGetPixelWidth(mode.0) }).ok()?;
    let height = u32::try_from(unsafe { CGDisplayModeGetPixelHeight(mode.0) }).ok()?;
    Display::new(id, points, width, height)
}

pub fn main_display() -> Option<Display> {
    display(unsafe { CGMainDisplayID() })
}

/// Returns None in a gap between displays. A capture must not silently jump to another monitor.
pub fn display_at(point: Point) -> Option<Display> {
    displays()?.into_iter().find(|d| d.points.contains(point))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppIdentity {
    pub pid: i32,
    /// Stable bundle ID; no executable path or document title is read or retained.
    pub bundle_id: Option<String>,
}

/// Run on the main thread (e.g. Tauri's run_on_main_thread). The result is absent elsewhere,
/// rather than messaging AppKit from an unvalidated worker thread.
pub fn frontmost_app() -> Option<AppIdentity> {
    if unsafe { pthread_main_np() } == 0 {
        return None;
    }
    objc2::rc::autoreleasepool(|_| unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace.is_null() {
            return None;
        }
        let app: *mut AnyObject = msg_send![workspace, frontmostApplication];
        if app.is_null() {
            return None;
        }
        let pid: i32 = msg_send![app, processIdentifier];
        if pid <= 0 {
            return None;
        }
        let bundle: *mut AnyObject = msg_send![app, bundleIdentifier];
        let bundle_id = if bundle.is_null() {
            None
        } else {
            let utf8: *const c_char = msg_send![bundle, UTF8String];
            if utf8.is_null() {
                None
            } else {
                CStr::from_ptr(utf8).to_str().ok().map(str::to_owned)
            }
        };
        Some(AppIdentity { pid, bundle_id })
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowSnapshot {
    pub id: u32,
    pub pid: i32,
    pub bounds: Rect,
    pub layer: i32,
    /// Alpha does not establish that every pixel is opaque; never use this to omit redaction.
    pub alpha: Option<f64>,
}

unsafe fn number(dict: Cf, key: Cf) -> Option<f64> {
    let value = unsafe { CFDictionaryGetValue(dict, key) };
    if value.is_null() || unsafe { CFGetTypeID(value) != CFNumberGetTypeID() } {
        return None;
    }
    let mut result: f64 = 0.;
    // kCFNumberFloat64Type = 6. All window IDs and PIDs fit exactly in an f64.
    (unsafe { CFNumberGetValue(value, 6, (&mut result as *mut f64).cast()) } && result.is_finite())
        .then_some(result)
}

/// On-screen metadata front to back. Missing data is an error, never evidence that the screen
/// is safe. Window titles are intentionally omitted; private-window detection needs its own
/// permission-aware adapter. This call does not request permissions or capture any pixels.
pub fn visible_windows() -> Option<Vec<WindowSnapshot>> {
    // kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements.
    let windows = Owned::new(unsafe { CGWindowListCopyWindowInfo(1 | 16, 0) })?;
    if unsafe { CFGetTypeID(windows.0) != CFArrayGetTypeID() } {
        return None;
    }
    let mut result = Vec::new();
    for index in 0..unsafe { CFArrayGetCount(windows.0) } {
        let dict = unsafe { CFArrayGetValueAtIndex(windows.0, index) };
        if dict.is_null() || unsafe { CFGetTypeID(dict) != CFDictionaryGetTypeID() } {
            return None;
        }
        let id = unsafe { number(dict, kCGWindowNumber) }?;
        let pid = unsafe { number(dict, kCGWindowOwnerPID) }?;
        let layer = unsafe { number(dict, kCGWindowLayer) }?;
        if id < 1.
            || id > u32::MAX as f64
            || id.fract() != 0.
            || pid < 1.
            || pid > i32::MAX as f64
            || pid.fract() != 0.
            || layer < i32::MIN as f64
            || layer > i32::MAX as f64
            || layer.fract() != 0.
        {
            return None;
        }
        let bounds = unsafe { CFDictionaryGetValue(dict, kCGWindowBounds) };
        if bounds.is_null() || unsafe { CFGetTypeID(bounds) != CFDictionaryGetTypeID() } {
            return None;
        }
        let mut rect = CgRect::default();
        if !unsafe { CGRectMakeWithDictionaryRepresentation(bounds, &mut rect) } {
            return None;
        }
        // Zero-sized windows are not capture candidates; they need no area blackout.
        if ![
            rect.origin.x,
            rect.origin.y,
            rect.size.width,
            rect.size.height,
        ]
        .iter()
        .all(|v| v.is_finite())
            || rect.size.width < 0.
            || rect.size.height < 0.
        {
            return None;
        }
        if rect.size.width == 0. || rect.size.height == 0. {
            continue;
        }
        let bounds = rect.checked()?;
        result.push(WindowSnapshot {
            id: id as u32,
            pid: pid as i32,
            bounds,
            layer: layer as i32,
            alpha: unsafe { number(dict, kCGWindowAlpha) }.filter(|a| (0. ..=1.).contains(a)),
        });
    }
    Some(result)
}

/// Top ordinary window owned by the frontmost app. This is a window-server z-order candidate,
/// not a verified Accessibility focused window; do not authorize a capture from it alone.
pub fn frontmost_window_candidate(app: &AppIdentity) -> Option<WindowSnapshot> {
    if app.pid == std::process::id() as i32 {
        return None;
    }
    visible_windows()?
        .into_iter()
        .find(|w| w.pid == app.pid && w.layer == 0)
}

pub fn app_window_at(point: Point) -> Option<WindowSnapshot> {
    let own_pid = std::process::id() as i32;
    visible_windows()?
        .into_iter()
        .find(|w| w.pid != own_pid && w.layer == 0 && w.bounds.contains(point))
}
