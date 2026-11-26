//! Public AX metadata-only binding of the focused element's window to a unique CG window.
//! AX has no public CGWindowID getter. Exact focused-window bounds + unique matching window
//! server metadata is deliberately conservative: ambiguous or transient geometry refuses.
use super::Rect;
use std::{
    ffi::c_void,
    time::{Duration, Instant},
};
type Cf = *const c_void;
#[repr(C)]
#[derive(Default)]
struct Pair {
    a: f64,
    b: f64,
}
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> Cf;
    fn AXUIElementGetTypeID() -> usize;
    fn AXUIElementGetPid(element: Cf, pid: *mut i32) -> i32;
    fn AXUIElementSetMessagingTimeout(element: Cf, seconds: f32) -> i32;
    fn AXUIElementCopyAttributeValue(element: Cf, attr: Cf, value: *mut Cf) -> i32;
    fn AXValueGetTypeID() -> usize;
    fn AXValueGetType(value: Cf) -> u32;
    fn AXValueGetValue(value: Cf, kind: u32, out: *mut c_void) -> u8;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Cf);
    fn CFGetTypeID(value: Cf) -> usize;
    fn CFEqual(a: Cf, b: Cf) -> u8;
    fn CFStringCreateWithBytes(
        allocator: Cf,
        bytes: *const u8,
        length: isize,
        encoding: u32,
        external: u8,
    ) -> Cf;
}
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
fn attribute(element: Cf, name: &str, started: Instant) -> Option<Owned> {
    if started.elapsed() >= Duration::from_millis(160) {
        return None;
    }
    let key = Owned::new(unsafe {
        CFStringCreateWithBytes(
            std::ptr::null(),
            name.as_ptr(),
            name.len() as isize,
            0x08000100,
            0,
        )
    })?;
    let mut value = std::ptr::null();
    let status = unsafe { AXUIElementCopyAttributeValue(element, key.0, &mut value) };
    let value = Owned::new(value);
    if status != 0 || started.elapsed() >= Duration::from_millis(160) {
        return None;
    }
    value
}
fn valid_element(element: Cf, expected_pid: i32) -> bool {
    if unsafe { CFGetTypeID(element) != AXUIElementGetTypeID() } {
        return false;
    }
    let mut pid = 0;
    unsafe {
        AXUIElementGetPid(element, &mut pid) == 0
            && pid == expected_pid
            && AXUIElementSetMessagingTimeout(element, 0.015) == 0
    }
}
fn pair(value: Cf, kind: u32) -> Option<Pair> {
    if unsafe { CFGetTypeID(value) != AXValueGetTypeID() || AXValueGetType(value) != kind } {
        return None;
    }
    let mut out = Pair::default();
    (unsafe { AXValueGetValue(value, kind, (&mut out as *mut Pair).cast()) } != 0).then_some(out)
}
pub(super) fn focused_window_matches(pid: i32, bounds: Rect) -> bool {
    checked(pid, bounds).unwrap_or(false)
}
fn checked(pid: i32, bounds: Rect) -> Option<bool> {
    let started = Instant::now();
    let app = Owned::new(unsafe { AXUIElementCreateApplication(pid) })?;
    if !valid_element(app.0, pid) {
        return None;
    }
    let focused_window = attribute(app.0, "AXFocusedWindow", started)?;
    let focused_element = attribute(app.0, "AXFocusedUIElement", started)?;
    if !valid_element(focused_window.0, pid) || !valid_element(focused_element.0, pid) {
        return None;
    }
    let element_window = attribute(focused_element.0, "AXWindow", started)?;
    if !valid_element(element_window.0, pid)
        || unsafe { CFEqual(focused_window.0, element_window.0) } == 0
    {
        return None;
    }
    let pos = attribute(focused_window.0, "AXPosition", started)?;
    let size = attribute(focused_window.0, "AXSize", started)?;
    // AXValueType kAXValueCGPointType=1, kAXValueCGSizeType=2 (AXValue.h).
    let pos = pair(pos.0, 1)?;
    let size = pair(size.0, 2)?;
    let actual = Rect::new(pos.a, pos.b, size.a, size.b)?;
    let again = attribute(app.0, "AXFocusedWindow", started)?;
    let element_again = attribute(app.0, "AXFocusedUIElement", started)?;
    Some(
        actual == bounds
            && unsafe {
                CFEqual(again.0, focused_window.0) != 0
                    && CFEqual(element_again.0, focused_element.0) != 0
            },
    )
}
