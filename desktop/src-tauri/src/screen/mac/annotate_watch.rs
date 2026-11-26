//! Metadata-only AX invalidation. No values, labels, titles, descendants or screenshots.
//! Observer callbacks carry a scalar turn token, never a pointer into borrowed Rust state.
use super::{AppHandle, Target};
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::c_void,
    time::{Duration, Instant},
};
type Cf = *const c_void;
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> Cf;
    fn AXUIElementGetPid(element: Cf, pid: *mut i32) -> i32;
    fn AXUIElementGetTypeID() -> usize;
    fn AXUIElementSetMessagingTimeout(element: Cf, seconds: f32) -> i32;
    fn AXUIElementCopyAttributeValue(element: Cf, name: Cf, value: *mut Cf) -> i32;
    fn AXObserverCreate(
        pid: i32,
        callback: extern "C" fn(Cf, Cf, Cf, *mut c_void),
        observer: *mut Cf,
    ) -> i32;
    fn AXObserverAddNotification(observer: Cf, element: Cf, name: Cf, token: *mut c_void) -> i32;
    fn AXObserverGetRunLoopSource(observer: Cf) -> Cf;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Cf);
    fn CFGetTypeID(value: Cf) -> usize;
    fn CFStringCreateWithBytes(
        allocator: Cf,
        bytes: *const u8,
        len: isize,
        encoding: u32,
        external: u8,
    ) -> Cf;
    fn CFRunLoopGetMain() -> Cf;
    fn CFRunLoopAddSource(run_loop: Cf, source: Cf, mode: Cf);
    fn CFRunLoopRemoveSource(run_loop: Cf, source: Cf, mode: Cf);
    static kCFRunLoopCommonModes: Cf;
}
struct Owned(Cf);
impl Owned {
    fn new(value: Cf) -> Option<Self> {
        (!value.is_null()).then_some(Self(value))
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}
struct Observer {
    native: Owned,
    app: AppHandle,
}
impl Drop for Observer {
    fn drop(&mut self) {
        unsafe {
            CFRunLoopRemoveSource(
                CFRunLoopGetMain(),
                AXObserverGetRunLoopSource(self.native.0),
                kCFRunLoopCommonModes,
            )
        };
    }
}
thread_local! {static OBSERVERS:RefCell<HashMap<u64,Observer>>=RefCell::new(HashMap::new());}
fn string(name: &str) -> Option<Owned> {
    Owned::new(unsafe {
        CFStringCreateWithBytes(
            std::ptr::null(),
            name.as_ptr(),
            name.len() as isize,
            0x08000100,
            0,
        )
    })
}
fn element(value: Cf, pid: i32) -> bool {
    let mut actual = 0;
    unsafe {
        CFGetTypeID(value) == AXUIElementGetTypeID()
            && AXUIElementGetPid(value, &mut actual) == 0
            && actual == pid
            && AXUIElementSetMessagingTimeout(value, 0.010) == 0
    }
}
fn attribute(element: Cf, name: &str, deadline: Instant) -> Option<Owned> {
    if Instant::now() >= deadline {
        return None;
    }
    let key = string(name)?;
    let mut result = std::ptr::null();
    let status = unsafe { AXUIElementCopyAttributeValue(element, key.0, &mut result) };
    let result = Owned::new(result);
    if status == 0 && Instant::now() < deadline {
        result
    } else {
        None
    }
}
extern "C" fn changed(_: Cf, _: Cf, _: Cf, token: *mut c_void) {
    // No Cocoa/CF object escapes the main queue. The callback can arrive after cancellation;
    // a removed token is ignored, and fade checks the active turn id before touching state.
    let _ = std::panic::catch_unwind(|| {
        let token = token as usize as u64;
        let app = OBSERVERS.with(|all| all.borrow().get(&token).map(|o| o.app.clone()));
        if let Some(app) = app {
            let _ = super::fade(&app, token);
        }
    });
}
/// Register native content/selection/layout and window/focus notifications when a producer
/// supports them. No unsupported notification is promoted into evidence of no content change.
pub(super) fn start(app: &AppHandle, id: u64, target: &Target) -> bool {
    if objc2::MainThreadMarker::new().is_none() || id == 0 || usize::try_from(id).is_err() {
        return false;
    }
    stop_now(id);
    let deadline = Instant::now() + Duration::from_millis(150);
    let Some(application) = Owned::new(unsafe { AXUIElementCreateApplication(target.process.pid) })
    else {
        return false;
    };
    if !element(application.0, target.process.pid) {
        return false;
    }
    let Some(window) = attribute(application.0, "AXFocusedWindow", deadline) else {
        return false;
    };
    if !element(window.0, target.process.pid) {
        return false;
    }
    let focused = attribute(application.0, "AXFocusedUIElement", deadline)
        .filter(|f| element(f.0, target.process.pid));
    let mut observer = std::ptr::null();
    let status = unsafe { AXObserverCreate(target.process.pid, changed, &mut observer) };
    let Some(observer) = Owned::new(observer) else {
        return false;
    };
    if status != 0 {
        return false;
    }
    let mut content_notifications = 0;
    for (element, names, content) in [
        (
            application.0,
            &[
                "AXFocusedWindowChanged",
                "AXFocusedUIElementChanged",
                "AXApplicationDeactivated",
                "AXWindowCreated",
                "AXSheetCreated",
                "AXHelpTagCreated",
            ][..],
            false,
        ),
        (
            window.0,
            &[
                "AXWindowMoved",
                "AXWindowResized",
                "AXUIElementDestroyed",
                "AXLayoutChanged",
                "AXSelectedChildrenChanged",
                "AXRowCountChanged",
                "AXValueChanged",
            ][..],
            true,
        ),
        (
            focused.as_ref().map(|f| f.0).unwrap_or(window.0),
            &[
                "AXValueChanged",
                "AXSelectedTextChanged",
                "AXSelectedChildrenChanged",
                "AXLayoutChanged",
                "AXRowCountChanged",
                "AXSelectedRowsChanged",
            ][..],
            true,
        ),
    ] {
        for name in names {
            if Instant::now() >= deadline {
                return false;
            }
            let Some(name_value) = string(name) else {
                return false;
            };
            let ok = unsafe {
                AXObserverAddNotification(
                    observer.0,
                    element,
                    name_value.0,
                    id as usize as *mut c_void,
                )
            } == 0;
            if ok && content && is_content_notification(name) {
                content_notifications += 1;
            }
        }
    }
    if Instant::now() >= deadline {
        return false;
    }
    let source = unsafe { AXObserverGetRunLoopSource(observer.0) };
    if source.is_null() {
        return false;
    }
    OBSERVERS.with(|all| {
        all.borrow_mut().insert(
            id,
            Observer {
                native: observer,
                app: app.clone(),
            },
        );
    });
    unsafe { CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes) };
    content_notifications > 0
}
fn is_content_notification(name: &str) -> bool {
    matches!(
        name,
        "AXValueChanged"
            | "AXSelectedTextChanged"
            | "AXSelectedChildrenChanged"
            | "AXLayoutChanged"
            | "AXRowCountChanged"
            | "AXSelectedRowsChanged"
    )
}
fn stop_now(id: u64) {
    OBSERVERS.with(|all| {
        all.borrow_mut().remove(&id);
    });
}
pub(super) fn stop(app: &AppHandle, id: u64) {
    if objc2::MainThreadMarker::new().is_some() {
        stop_now(id);
    } else {
        let _ = app.run_on_main_thread(move || stop_now(id));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn content_notifications_do_not_read_or_expose_values() {
        for n in [
            "AXValueChanged",
            "AXLayoutChanged",
            "AXSelectedTextChanged",
            "AXRowCountChanged",
        ] {
            assert!(is_content_notification(n));
        }
        for n in [
            "AXTitle",
            "AXValue",
            "AXWindowMoved",
            "AXFocusedUIElementChanged",
            "unknown",
        ] {
            assert!(!is_content_notification(n));
        }
    }
}
