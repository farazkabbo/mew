//! Read-only pointer state. No event tap, keyboard recording, input injection, or permission
//! request. Cursor coordinates are Quartz top-left global points; convert through a Display.
use super::target::Point;
use std::ffi::c_void;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreate(source: *const c_void) -> *const c_void;
    fn CGEventGetLocation(event: *const c_void) -> Point;
    fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: *const c_void);
}

pub fn cursor() -> Option<Point> {
    // A null source creates a snapshot of current event state; no event is posted or retained.
    let event = unsafe { CGEventCreate(std::ptr::null()) };
    if event.is_null() {
        return None;
    }
    let point = unsafe { CGEventGetLocation(event) };
    unsafe { CFRelease(event) };
    (point.x.is_finite() && point.y.is_finite()).then_some(point)
}

/// Quartz left-button state in the combined session. Callers that support custom primary
/// button mappings must resolve that mapping separately; this does not infer handedness.
pub fn left_button_down() -> bool {
    unsafe { CGEventSourceButtonState(0, 0) }
}
