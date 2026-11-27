//! Bounded exact AX window + optional pointer hit-test. No field values or document tree.
use super::actions::{Action, BoundTarget};
use super::target;
use std::ffi::c_void;
use std::time::Instant;
type Cf = *const c_void;
#[repr(C)]
#[derive(Default)]
pub(crate) struct Pair {
    pub(crate) a: f64,
    pub(crate) b: f64,
}
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> Cf;
    fn AXUIElementGetTypeID() -> usize;
    fn AXUIElementGetPid(element: Cf, pid: *mut i32) -> i32;
    fn AXUIElementSetMessagingTimeout(element: Cf, seconds: f32) -> i32;
    fn AXUIElementCopyAttributeValue(element: Cf, name: Cf, out: *mut Cf) -> i32;
    fn AXUIElementIsAttributeSettable(element: Cf, name: Cf, settable: *mut u8) -> i32;
    fn AXUIElementCopyElementAtPosition(element: Cf, x: f32, y: f32, out: *mut Cf) -> i32;
    fn AXValueGetTypeID() -> usize;
    fn AXValueGetType(value: Cf) -> u32;
    fn AXValueGetValue(value: Cf, kind: u32, out: *mut c_void) -> u8;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Cf);
    fn CFRetain(value: Cf) -> Cf;
    fn CFArrayGetTypeID() -> usize;
    fn CFArrayGetCount(value: Cf) -> isize;
    fn CFArrayGetValueAtIndex(value: Cf, index: isize) -> Cf;
    fn CFGetTypeID(value: Cf) -> usize;
    fn CFEqual(a: Cf, b: Cf) -> u8;
    fn CFStringCreateWithBytes(
        allocator: Cf,
        bytes: *const u8,
        length: isize,
        encoding: u32,
        external: u8,
    ) -> Cf;
    fn CFStringGetTypeID() -> usize;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(value: Cf) -> u8;
    fn CFStringGetLength(value: Cf) -> isize;
    fn CFStringGetCString(value: Cf, buffer: *mut u8, size: isize, encoding: u32) -> u8;
}
pub(crate) struct Owned(pub(crate) Cf);
impl Owned {
    pub(crate) fn new(value: Cf) -> Option<Self> {
        (!value.is_null()).then_some(Self(value))
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}
pub(crate) fn element(value: Cf, pid: i32) -> bool {
    let mut actual = 0;
    unsafe {
        CFGetTypeID(value) == AXUIElementGetTypeID()
            && AXUIElementGetPid(value, &mut actual) == 0
            && actual == pid
            && AXUIElementSetMessagingTimeout(value, 0.010) == 0
    }
}
pub(crate) fn attr(value: Cf, name: &str, deadline: Instant) -> Option<Owned> {
    if Instant::now() >= deadline {
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
    let mut out = std::ptr::null();
    let status = unsafe { AXUIElementCopyAttributeValue(value, key.0, &mut out) };
    let owned = Owned::new(out);
    if status != 0 || Instant::now() >= deadline {
        None
    } else {
        owned
    }
}
/// Explicit optional-subrole absence is distinct from a failed or late AX read.
fn optional_subrole(value: Cf, deadline: Instant) -> Option<Option<String>> {
    if Instant::now() >= deadline {
        return None;
    }
    let name = b"AXSubrole";
    let key = Owned::new(unsafe {
        CFStringCreateWithBytes(
            std::ptr::null(),
            name.as_ptr(),
            name.len() as isize,
            0x08000100,
            0,
        )
    })?;
    let mut out = std::ptr::null();
    let status = unsafe { AXUIElementCopyAttributeValue(value, key.0, &mut out) };
    let owned = Owned::new(out);
    if Instant::now() >= deadline {
        return None;
    }
    if status == -25205 && owned.is_none() {
        return Some(None);
    }
    if status != 0 {
        return None;
    }
    Some(Some(string(owned?.0)?))
}
pub(crate) fn string(value: Cf) -> Option<String> {
    string_bounded(value, 256)
}
pub(crate) fn string_bounded(value: Cf, max: usize) -> Option<String> {
    if max > 16000
        || unsafe {
            CFGetTypeID(value) != CFStringGetTypeID() || CFStringGetLength(value) > max as isize
        }
    {
        return None;
    }
    let mut buf = vec![0u8; max * 4 + 1];
    if unsafe { CFStringGetCString(value, buf.as_mut_ptr(), buf.len() as isize, 0x08000100) } == 0 {
        return None;
    }
    let n = buf.iter().position(|v| *v == 0)?;
    let result = std::str::from_utf8(&buf[..n]).ok().map(str::to_owned);
    crate::screen::secret::wipe(&mut buf);
    result
}
pub(crate) fn boolean(value: Cf) -> Option<bool> {
    (unsafe { CFGetTypeID(value) == CFBooleanGetTypeID() })
        .then(|| unsafe { CFBooleanGetValue(value) != 0 })
}

pub(crate) fn pair(value: Cf, kind: u32) -> Option<Pair> {
    if unsafe { CFGetTypeID(value) != AXValueGetTypeID() || AXValueGetType(value) != kind } {
        return None;
    }
    let mut out = Pair::default();
    (unsafe { AXValueGetValue(value, kind, (&mut out as *mut Pair).cast()) } != 0).then_some(out)
}
pub(super) fn matches(
    expected: &BoundTarget,
    point: Option<target::Point>,
    label: Option<&str>,
    action: &Action,
    deadline: Instant,
) -> bool {
    checked(expected, point, label, action, deadline).unwrap_or(false)
}
fn checked(
    expected: &BoundTarget,
    point: Option<target::Point>,
    label: Option<&str>,
    action: &Action,
    deadline: Instant,
) -> Option<bool> {
    let pid = expected.process.pid;
    let app = Owned::new(unsafe { AXUIElementCreateApplication(pid) })?;
    if !element(app.0, pid) {
        return None;
    }
    let focused = attr(app.0, "AXFocusedWindow", deadline)?;
    if !element(focused.0, pid) {
        return None;
    }
    let pos = attr(focused.0, "AXPosition", deadline)?;
    let pos = pair(pos.0, 1)?;
    let size = attr(focused.0, "AXSize", deadline)?;
    let size = pair(size.0, 2)?;
    if target::Rect::new(pos.a, pos.b, size.a, size.b) != Some(expected.bounds) {
        return None;
    }
    let target = if let Some(point) = point {
        if !expected.bounds.contains(point) {
            return None;
        }
        let mut hit = std::ptr::null();
        if unsafe {
            AXUIElementCopyElementAtPosition(app.0, point.x as f32, point.y as f32, &mut hit)
        } != 0
        {
            return None;
        }
        Owned::new(hit)?
    } else {
        attr(app.0, "AXFocusedUIElement", deadline)?
    };
    if !element(target.0, pid) {
        return None;
    }
    let window = attr(target.0, "AXWindow", deadline)?;
    if unsafe { CFEqual(window.0, focused.0) } == 0 {
        return None;
    }
    // Moving cannot activate a control or enter text. Exact process/window/hit binding
    // above still applies; document containers and whitespace are valid cursor path points.
    if matches!(action, Action::Move(_)) {
        let again = attr(app.0, "AXFocusedWindow", deadline)?;
        return Some(equal(&again, &focused) && Instant::now() < deadline);
    }
    let role = string(attr(target.0, "AXRole", deadline)?.0)?;
    if !matches!(
        role.as_str(),
        "AXTextArea"
            | "AXTextField"
            | "AXButton"
            | "AXCheckBox"
            | "AXRadioButton"
            | "AXPopUpButton"
            | "AXComboBox"
            | "AXMenuItem"
            | "AXTabGroup"
            | "AXLink"
            | "AXStaticText"
            | "AXScrollArea"
    ) {
        return None;
    }
    let subrole = optional_subrole(target.0, deadline)?;
    let native = attr(target.0, "AXTitle", deadline)
        .or_else(|| attr(target.0, "AXDescription", deadline))
        .and_then(|v| string(v.0));
    let editable = if matches!(role.as_str(), "AXTextArea" | "AXTextField") {
        let key = Owned::new(unsafe {
            CFStringCreateWithBytes(std::ptr::null(), b"AXValue".as_ptr(), 7, 0x08000100, 0)
        })?;
        let mut value = 0u8;
        unsafe { AXUIElementIsAttributeSettable(target.0, key.0, &mut value) == 0 && value != 0 }
    } else {
        false
    };
    if role == "AXTextField"
        && matches!(
            action,
            Action::Key(crate::screen::mac::actions::PlainKey::Enter)
        )
    {
        // Validate the actual assembled value, not chunks: a model must not split an
        // executable URI across otherwise harmless Type actions and then press Enter.
        let mut value = string_bounded(attr(target.0, "AXValue", deadline)?.0, 2000)?;
        let safe = safe_submitted_field(&value);
        crate::screen::secret::wipe(unsafe { value.as_bytes_mut() });
        if !safe {
            return None;
        }
    }
    if !control_allows_input(
        &role,
        subrole.as_deref(),
        native.as_deref(),
        editable,
        action,
    ) {
        return None;
    }
    if let Some(label) = label {
        if native.as_deref()?.trim().to_lowercase() != label.trim().to_lowercase() {
            return None;
        }
    }
    let again = attr(app.0, "AXFocusedWindow", deadline)?;
    Some(unsafe { CFEqual(again.0, focused.0) } != 0 && Instant::now() < deadline)
}

pub(crate) fn application(pid: i32) -> Option<Owned> {
    Owned::new(unsafe { AXUIElementCreateApplication(pid) })
}
pub(crate) fn children(value: &Owned, max: usize, deadline: Instant) -> Vec<Owned> {
    let Some(array) = attr(value.0, "AXChildren", deadline) else {
        return vec![];
    };
    if unsafe { CFGetTypeID(array.0) != CFArrayGetTypeID() } {
        return vec![];
    }
    let n = unsafe { CFArrayGetCount(array.0) };
    if n < 0 {
        return vec![];
    }
    (0..(n as usize).min(max))
        .filter_map(|i| {
            Owned::new(unsafe { CFRetain(CFArrayGetValueAtIndex(array.0, i as isize)) })
        })
        .collect()
}

pub(crate) fn equal(a: &Owned, b: &Owned) -> bool {
    unsafe { CFEqual(a.0, b.0) != 0 }
}

fn safe_submitted_field(value: &str) -> bool {
    let value = value.trim();
    let Some((scheme, _)) = value.split_once(':') else {
        return true;
    };
    let scheme = scheme
        .chars()
        .filter(|c| !c.is_ascii_whitespace() && !c.is_ascii_control())
        .collect::<String>()
        .to_ascii_lowercase();
    if scheme != "https" {
        return false;
    }
    crate::screen::hand_protocol::safe_url(value)
        && tauri::Url::parse(value).is_ok_and(|url| {
            url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
        })
}

/// A native control's role and writable status authorize input independently of model labels.
fn control_allows_input(
    role: &str,
    subrole: Option<&str>,
    name: Option<&str>,
    editable: bool,
    action: &Action,
) -> bool {
    use crate::screen::mac::actions::PlainKey;
    if role == "AXSecureTextField" || subrole == Some("AXSecureTextField") {
        return false;
    }
    if matches!(action, Action::Move(_) | Action::Scroll { .. }) {
        return true;
    }
    if matches!(
        subrole,
        Some("AXCloseButton" | "AXMinimizeButton" | "AXZoomButton" | "AXFullScreenButton")
    ) {
        return false;
    }
    if name.is_some_and(crate::screen::hand_protocol::risky_label) {
        return false;
    }
    if role == "AXTextField" && subrole == Some("AXSearchField") {
        if let Action::Text(value) = action {
            let lower = value.trim_start().to_ascii_lowercase();
            if [
                "javascript:",
                "data:",
                "vbscript:",
                "file:",
                "about:",
                "chrome:",
                "brave:",
                "edge:",
            ]
            .iter()
            .any(|scheme| lower.starts_with(scheme))
            {
                return false;
            }
        }
    }
    let text = editable && (role == "AXTextArea" || role == "AXTextField");
    match action {
        Action::Text(value) => {
            text && (role == "AXTextArea" || !value.contains(['\n', '\r', '\t']))
        }
        Action::Key(PlainKey::Enter | PlainKey::Backspace) => text,
        Action::Click { .. } => name.is_some_and(|name| !name.trim().is_empty()),
        _ => true,
    }
}
#[cfg(test)]
mod input_policy_tests {
    use super::*;
    use crate::screen::mac::actions::PlainKey;
    #[test]
    fn enter_validates_assembled_uri_even_when_typing_was_split_into_chunks() {
        assert!(!safe_submitted_field(" java\tscript:alert(1)"));
        assert!(!safe_submitted_field("data:text/html,secret"));
        assert!(!safe_submitted_field("shortcuts://run-shortcut?name=test"));
        assert!(!safe_submitted_field("x-apple.systempreferences:privacy"));
        assert!(!safe_submitted_field("mailto:someone@example.com"));
        assert!(!safe_submitted_field("custom-app://run"));
        assert!(safe_submitted_field("https://example.com/path"));
        assert!(safe_submitted_field("ordinary search"));
    }
    #[test]
    fn search_fields_cannot_receive_executable_or_local_url_schemes() {
        for value in [
            "javascript:alert(1)",
            " DATA:text/html,secret",
            "file:///private/file",
            "chrome://settings",
        ] {
            assert!(!control_allows_input(
                "AXTextField",
                Some("AXSearchField"),
                None,
                true,
                &Action::Text(value.into())
            ));
        }
        assert!(control_allows_input(
            "AXTextField",
            Some("AXSearchField"),
            None,
            true,
            &Action::Text("https://example.com".into())
        ));
    }
    #[test]
    fn unlabeled_model_keys_never_activate_risky_toolbar_or_window_controls() {
        for name in ["Share", "Delete", "Sign In"] {
            assert!(!control_allows_input(
                "AXButton",
                Some("AXToolbarButton"),
                Some(name),
                false,
                &Action::Key(PlainKey::Enter)
            ));
        }
        assert!(!control_allows_input(
            "AXButton",
            Some("AXCloseButton"),
            Some("Close"),
            false,
            &Action::Text(" ".into())
        ));
        assert!(!control_allows_input(
            "AXButton",
            Some("AXToolbarButton"),
            Some("Insert"),
            false,
            &Action::Text("hello".into())
        ));
    }
    #[test]
    fn document_typing_requires_native_writable_status_and_ordinary_text_role() {
        assert!(control_allows_input(
            "AXTextArea",
            None,
            None,
            true,
            &Action::Text("Hello\nworld".into())
        ));
        assert!(!control_allows_input(
            "AXTextArea",
            None,
            None,
            false,
            &Action::Text("Hello".into())
        ));
        assert!(!control_allows_input(
            "AXTextField",
            Some("AXSecureTextField"),
            None,
            true,
            &Action::Text("Hello".into())
        ));
        assert!(!control_allows_input(
            "AXTextField",
            Some("AXSearchField"),
            None,
            true,
            &Action::Text("Hello\n".into())
        ));
    }
}
