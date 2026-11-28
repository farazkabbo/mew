//! Read-only Accessibility metadata, never a capture authorization by itself.
//! No AX values, text, titles, descendants, actions, permission prompts or pixels are read.
//! AppKit identity discovery and `snapshot` must run on the main thread. AX requests are
//! limited to two focused-element reads and two attribute reads, with per-object timeouts.

use super::app_policy::{self, AppClass, PrivateState};
use crate::screen::privacy::Focus;

/// LaunchServices identity. A PID alone is insufficient because macOS can reuse it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: i32,
    pub bundle_id: String,
    /// Exact NSDate timeIntervalSinceReferenceDate bits; absent launch dates are rejected.
    pub launch_time_bits: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnknownReason {
    AccessibilityUnavailable,
    IdentityUnavailable,
    TargetChanged,
    FocusUnavailable,
    UnsupportedRole,
    Deadline,
}

/// No public cross-app API used here establishes private browsing or call/share absence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivacyProof {
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FocusSnapshot {
    pub focus: Focus,
    pub unknown_reason: Option<UnknownReason>,
    /// Standard AX constants only, never a field's entered text or accessible label.
    pub role: Option<String>,
    pub subrole: Option<String>,
    pub private_browsing: PrivateState,
    pub call_or_screen_share: PrivacyProof,
}

impl FocusSnapshot {
    fn unknown(reason: UnknownReason) -> Self {
        Self {
            focus: Focus::Unknown,
            unknown_reason: Some(reason),
            role: None,
            subrole: None,
            private_browsing: PrivateState::Unknown,
            call_or_screen_share: PrivacyProof::Unknown,
        }
    }
}

/// Optional metadata absence is not an AX transport error. Only the SDK's explicit
/// kAXErrorAttributeUnsupported establishes absence; timeout, no-value and malformed reads fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Subrole<'a> {
    Value(&'a str),
    Unsupported,
    Failed(UnknownReason),
}

/// The SDK defines AXTextArea as ordinary multi-line text and AXSecureTextField as a
/// protected subrole. AXSubroleAttribute is optional when the role fully describes an element
/// (AXAttributeConstants.h). Limit that contract to positively identified native producers.
fn classify(
    bundle_id: &str,
    expected_pid: i32,
    actual_pid: i32,
    role: Option<&str>,
    subrole: Subrole<'_>,
) -> Focus {
    classify_with_companion(bundle_id, expected_pid, actual_pid, role, subrole, false)
}
fn classify_with_companion(
    bundle_id: &str,
    expected_pid: i32,
    actual_pid: i32,
    role: Option<&str>,
    subrole: Subrole<'_>,
    companion: bool,
) -> Focus {
    if expected_pid <= 0 || actual_pid != expected_pid {
        return Focus::Unknown;
    }
    if role == Some("AXSecureTextField") || subrole == Subrole::Value("AXSecureTextField") {
        return Focus::Password;
    }
    if app_policy::has_inspected_browser_dictionary(bundle_id)
        || companion && crate::browser_companion_auth::browser_identifier(bundle_id)
    {
        // Chromium maps protected text to AXSecureTextField subrole. Ordinary role absence
        // is accepted only for this identified producer and only on explicit unsupported
        // optional-subrole metadata; errors/no-value never become absence. Capture separately
        // requires uniquely bound normal browser-window mode (this focus alone is insufficient).
        // Source: chromium ui/accessibility/platform/ax_platform_node_cocoa.mm, AXSubrole.
        return match (role, subrole) {
            (
                Some("AXWebArea" | "AXButton" | "AXTextArea" | "AXTextField"),
                Subrole::Unsupported,
            ) => Focus::Ordinary,
            (Some("AXTextField"), Subrole::Value("AXSearchField")) => Focus::Ordinary,
            _ => Focus::Unknown,
        };
    }
    if app_policy::classify_app(bundle_id) != AppClass::SupportedNative {
        return Focus::Unknown;
    }
    match (role, subrole) {
        (Some("AXTextArea"), Subrole::Unsupported)
        | (Some("AXTextField"), Subrole::Value("AXSearchField"))
        | (
            Some("AXButton"),
            Subrole::Value(
                "AXCloseButton" | "AXMinimizeButton" | "AXZoomButton" | "AXToolbarButton"
                | "AXFullScreenButton",
            ),
        ) => Focus::Ordinary,
        _ => Focus::Unknown,
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use objc2::{class, msg_send, runtime::AnyObject};
    use std::{
        ffi::c_void,
        time::{Duration, Instant},
    };

    type Cf = *const c_void;
    const CALL_TIMEOUT: f32 = 0.05;
    const TOTAL_BUDGET: Duration = Duration::from_millis(350);
    const MAX_METADATA_UNITS: usize = 128;
    #[repr(C)]
    struct CfRange {
        location: isize,
        length: isize,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXUIElementCreateApplication(pid: i32) -> Cf;
        fn AXUIElementGetTypeID() -> usize;
        fn AXUIElementGetPid(element: Cf, pid: *mut i32) -> i32;
        fn AXUIElementSetMessagingTimeout(element: Cf, seconds: f32) -> i32;
        fn AXUIElementCopyAttributeValue(element: Cf, attribute: Cf, result: *mut Cf) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: Cf);
        fn CFGetTypeID(value: Cf) -> usize;
        fn CFEqual(first: Cf, second: Cf) -> u8;
        fn CFStringGetTypeID() -> usize;
        fn CFStringGetLength(string: Cf) -> isize;
        fn CFStringGetCharacters(string: Cf, range: CfRange, buffer: *mut u16);
        fn CFStringCreateWithBytes(
            allocator: Cf,
            bytes: *const u8,
            length: isize,
            encoding: u32,
            external: u8,
        ) -> Cf;
    }
    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {}
    unsafe extern "C" {
        fn pthread_main_np() -> i32;
    }

    /// Owns exactly one Create/Copy reference; borrowed CF values never enter this type.
    struct Owned(Cf);
    impl Owned {
        fn new(value: Cf) -> Option<Self> {
            (!value.is_null()).then_some(Self(value))
        }
        fn attribute(name: &'static str) -> Option<Self> {
            // UTF-8 constant attribute names only. kCFStringEncodingUTF8 = 0x08000100.
            Self::new(unsafe {
                CFStringCreateWithBytes(
                    std::ptr::null(),
                    name.as_ptr(),
                    name.len() as isize,
                    0x08000100,
                    0,
                )
            })
        }
    }
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) };
        }
    }

    fn cf_string(value: Cf, maximum: usize) -> Option<String> {
        if value.is_null() || unsafe { CFGetTypeID(value) != CFStringGetTypeID() } {
            return None;
        }
        let length = usize::try_from(unsafe { CFStringGetLength(value) }).ok()?;
        if length == 0 || length > maximum {
            return None;
        }
        let mut units = vec![0u16; length];
        // The CF type and range were checked; CFStringGetCharacters copies, not borrows.
        unsafe {
            CFStringGetCharacters(
                value,
                CfRange {
                    location: 0,
                    length: length as isize,
                },
                units.as_mut_ptr(),
            )
        };
        String::from_utf16(&units).ok()
    }

    /// Does not prompt, open System Settings, or request trust.
    pub fn accessibility_trusted() -> bool {
        unsafe { AXIsProcessTrusted() != 0 }
    }

    fn identity(app: *mut AnyObject) -> Option<ProcessIdentity> {
        if app.is_null() {
            return None;
        }
        // Only NSRunningApplication objects obtained from AppKit enter this helper.
        unsafe {
            let terminated: bool = msg_send![app, isTerminated];
            let pid: i32 = msg_send![app, processIdentifier];
            if terminated || pid <= 0 {
                return None;
            }
            let bundle: *mut AnyObject = msg_send![app, bundleIdentifier];
            let bundle_id = cf_string(bundle.cast(), 255)?;
            // A bundle identifier is an exact policy key, not a localized application name.
            if !bundle_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
            {
                return None;
            }
            let date: *mut AnyObject = msg_send![app, launchDate];
            if date.is_null() {
                return None;
            }
            let launched: f64 = msg_send![date, timeIntervalSinceReferenceDate];
            if !launched.is_finite() {
                return None;
            }
            Some(ProcessIdentity {
                pid,
                bundle_id,
                launch_time_bits: launched.to_bits(),
            })
        }
    }

    /// Main thread only. Missing LaunchServices metadata is explicitly unavailable.
    pub fn process_identity(pid: i32) -> Option<ProcessIdentity> {
        if pid <= 0 || unsafe { pthread_main_np() } == 0 {
            return None;
        }
        objc2::rc::autoreleasepool(|_| unsafe {
            let app: *mut AnyObject = msg_send![class!(NSRunningApplication),
                runningApplicationWithProcessIdentifier: pid];
            identity(app).filter(|app| app.pid == pid)
        })
    }

    pub fn frontmost_process_identity() -> Option<ProcessIdentity> {
        if unsafe { pthread_main_np() } == 0 {
            return None;
        }
        objc2::rc::autoreleasepool(|_| unsafe {
            let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            if workspace.is_null() {
                return None;
            }
            let app: *mut AnyObject = msg_send![workspace, frontmostApplication];
            identity(app)
        })
    }

    fn copy_optional_attribute(
        element: Cf,
        name: &'static str,
        started: Instant,
    ) -> Result<Option<Owned>, UnknownReason> {
        if started.elapsed() >= TOTAL_BUDGET {
            return Err(UnknownReason::Deadline);
        }
        let key = Owned::attribute(name).ok_or(UnknownReason::FocusUnavailable)?;
        let mut value = std::ptr::null();
        let status = unsafe { AXUIElementCopyAttributeValue(element, key.0, &mut value) };
        // Even an anomalous error accompanied by a Copy result releases that result.
        let result = Owned::new(value);
        if started.elapsed() >= TOTAL_BUDGET {
            return Err(UnknownReason::Deadline);
        }
        match status {
            0 => result.map(Some).ok_or(UnknownReason::FocusUnavailable),
            // kAXErrorAttributeUnsupported only. kAXErrorCannotComplete and kAXErrorNoValue
            // are not absence and must never make an ordinary AXTextArea authorization.
            -25205 if result.is_none() => Ok(None),
            _ => Err(UnknownReason::FocusUnavailable),
        }
    }

    fn copy_attribute(
        element: Cf,
        name: &'static str,
        started: Instant,
    ) -> Result<Owned, UnknownReason> {
        copy_optional_attribute(element, name, started)?.ok_or(UnknownReason::FocusUnavailable)
    }

    fn element_pid(element: Cf) -> Option<i32> {
        if element.is_null() || unsafe { CFGetTypeID(element) != AXUIElementGetTypeID() } {
            return None;
        }
        let mut pid = 0;
        (unsafe { AXUIElementGetPid(element, &mut pid) } == 0 && pid > 0).then_some(pid)
    }

    /// Evidence for a single instant, to recheck at capture/use time. Requires expected full
    /// launch identity and frontmost ownership before AND after reads. Never authorize pixels
    /// from this alone: private browsing and call/share status remain Unknown.
    pub fn snapshot(expected: &ProcessIdentity) -> FocusSnapshot {
        match checked_snapshot(expected, true, false) {
            Ok(snapshot) => snapshot,
            Err(reason) => FocusSnapshot::unknown(reason),
        }
    }

    /// Metadata-only retained-source check. The caller must first prove that the exact
    /// bundled Circle Card/keyboard Draw owns focus and the source AX/CG window still
    /// matches. This function neither authorizes capture nor requests permissions.
    pub(crate) fn retained_focus(expected: &ProcessIdentity) -> FocusSnapshot {
        match checked_snapshot(expected, false, false) {
            Ok(snapshot) => snapshot,
            Err(reason) => FocusSnapshot::unknown(reason),
        }
    }
    /// Caller supplies a fresh, authenticated and native-window-bound normal-browser proof.
    /// This only expands the producer role contract, never private/call/capture permission.
    pub(crate) fn companion_focus(expected: &ProcessIdentity, retained: bool) -> FocusSnapshot {
        checked_snapshot(expected, !retained, true).unwrap_or_else(FocusSnapshot::unknown)
    }
    fn checked_snapshot(
        expected: &ProcessIdentity,
        require_frontmost: bool,
        companion: bool,
    ) -> Result<FocusSnapshot, UnknownReason> {
        let started = Instant::now();
        if !accessibility_trusted() {
            return Err(UnknownReason::AccessibilityUnavailable);
        }
        let before = if require_frontmost {
            frontmost_process_identity()
        } else {
            process_identity(expected.pid)
        }
        .ok_or(UnknownReason::IdentityUnavailable)?;
        if &before != expected {
            return Err(UnknownReason::TargetChanged);
        }
        let app = Owned::new(unsafe { AXUIElementCreateApplication(expected.pid) })
            .ok_or(UnknownReason::FocusUnavailable)?;
        if element_pid(app.0) != Some(expected.pid)
            || unsafe { AXUIElementSetMessagingTimeout(app.0, CALL_TIMEOUT) } != 0
        {
            return Err(UnknownReason::FocusUnavailable);
        }
        let focused = copy_attribute(app.0, "AXFocusedUIElement", started)?;
        let actual_pid = element_pid(focused.0).ok_or(UnknownReason::FocusUnavailable)?;
        if actual_pid != expected.pid {
            return Err(UnknownReason::TargetChanged);
        }
        if unsafe { AXUIElementSetMessagingTimeout(focused.0, CALL_TIMEOUT) } != 0 {
            return Err(UnknownReason::FocusUnavailable);
        }
        let role_value = copy_attribute(focused.0, "AXRole", started)?;
        let role =
            cf_string(role_value.0, MAX_METADATA_UNITS).ok_or(UnknownReason::FocusUnavailable)?;
        // Preserve explicit optional-attribute absence separately from malformed data,
        // timeout and AX messaging errors. A secure role still refuses on subrole failure.
        let subrole_read = copy_optional_attribute(focused.0, "AXSubrole", started);
        let subrole_text = match &subrole_read {
            Ok(Some(value)) => cf_string(value.0, MAX_METADATA_UNITS),
            _ => None,
        };
        let subrole_status = match &subrole_read {
            Ok(None) => Subrole::Unsupported,
            Ok(Some(_)) => subrole_text
                .as_deref()
                .map(Subrole::Value)
                .unwrap_or(Subrole::Failed(UnknownReason::FocusUnavailable)),
            Err(reason) => Subrole::Failed(*reason),
        };
        let again = copy_attribute(app.0, "AXFocusedUIElement", started)?;
        if element_pid(again.0) != Some(expected.pid)
            || unsafe { CFEqual(focused.0, again.0) } == 0
            || process_identity(expected.pid).as_ref() != Some(expected)
            || (require_frontmost && frontmost_process_identity().as_ref() != Some(expected))
            || !accessibility_trusted()
        {
            return Err(UnknownReason::TargetChanged);
        }
        if started.elapsed() >= TOTAL_BUDGET {
            return Err(UnknownReason::Deadline);
        }
        let focus = if companion {
            classify_with_companion(
                &expected.bundle_id,
                expected.pid,
                actual_pid,
                Some(&role),
                subrole_status,
                true,
            )
        } else {
            classify(
                &expected.bundle_id,
                expected.pid,
                actual_pid,
                Some(&role),
                subrole_status,
            )
        };
        if focus != Focus::Password {
            if let Subrole::Failed(reason) = subrole_status {
                return Err(reason);
            }
        }
        // Return only recognized constant metadata, so a custom role cannot smuggle text into
        // retained results. Unsupported combinations intentionally discard both strings.
        if focus == Focus::Unknown {
            return Err(UnknownReason::UnsupportedRole);
        }
        let role = matches!(
            role.as_str(),
            "AXTextField" | "AXTextArea" | "AXSecureTextField" | "AXButton" | "AXWebArea"
        )
        .then_some(role);
        let subrole = subrole_text.filter(|subrole| {
            matches!(
                subrole.as_str(),
                "AXSecureTextField"
                    | "AXSearchField"
                    | "AXCloseButton"
                    | "AXMinimizeButton"
                    | "AXZoomButton"
                    | "AXToolbarButton"
                    | "AXFullScreenButton"
            )
        });
        Ok(FocusSnapshot {
            focus,
            unknown_reason: None,
            role,
            subrole,
            private_browsing: app_policy::private_state(&expected.bundle_id),
            call_or_screen_share: PrivacyProof::Unknown,
        })
    }
}

#[cfg(target_os = "macos")]
pub use native::{accessibility_trusted, frontmost_process_identity, process_identity, snapshot};
#[cfg(target_os = "macos")]
pub(crate) use native::{companion_focus, retained_focus};

#[cfg(test)]
mod tests {
    use super::*;
    const TEXTEDIT: &str = "com.apple.TextEdit";

    #[test]
    fn companion_producer_contract_is_explicit_and_never_overrides_secure_focus() {
        let browser = "org.mozilla.firefox";
        assert_eq!(
            classify(browser, 42, 42, Some("AXWebArea"), Subrole::Unsupported),
            Focus::Unknown
        );
        assert_eq!(
            classify_with_companion(
                browser,
                42,
                42,
                Some("AXWebArea"),
                Subrole::Unsupported,
                true
            ),
            Focus::Ordinary
        );
        for id in [browser, "org.example.Browser"] {
            assert_eq!(
                classify_with_companion(
                    id,
                    42,
                    42,
                    Some("AXTextField"),
                    Subrole::Value("AXSecureTextField"),
                    true
                ),
                Focus::Password
            );
            assert_eq!(
                classify_with_companion(id, 42, 43, Some("AXWebArea"), Subrole::Unsupported, true),
                Focus::Unknown
            );
            assert_eq!(
                classify_with_companion(
                    id,
                    42,
                    42,
                    Some("AXWebArea"),
                    Subrole::Failed(UnknownReason::Deadline),
                    true
                ),
                Focus::Unknown
            );
        }
        assert_eq!(
            classify_with_companion(
                "org.example.Browser",
                42,
                42,
                Some("AXWebArea"),
                Subrole::Unsupported,
                true
            ),
            Focus::Unknown
        );
    }
    #[test]
    fn ordinary_textedit_text_area_uses_explicit_optional_absence() {
        assert_eq!(
            classify(TEXTEDIT, 42, 42, Some("AXTextArea"), Subrole::Unsupported),
            Focus::Ordinary
        );
        for subrole in [
            Subrole::Failed(UnknownReason::FocusUnavailable),
            Subrole::Failed(UnknownReason::Deadline),
            Subrole::Value("AXUnknown"),
            Subrole::Value("Custom"),
        ] {
            assert_eq!(
                classify(TEXTEDIT, 42, 42, Some("AXTextArea"), subrole),
                Focus::Unknown
            );
        }
    }

    #[test]
    fn secure_focus_outranks_producer_support_and_subrole_failure() {
        for bundle in [TEXTEDIT, "com.apple.Safari", "org.example.Unknown"] {
            assert_eq!(
                classify(
                    bundle,
                    42,
                    42,
                    Some("AXTextField"),
                    Subrole::Value("AXSecureTextField")
                ),
                Focus::Password
            );
            assert_eq!(
                classify(
                    bundle,
                    42,
                    42,
                    Some("AXSecureTextField"),
                    Subrole::Failed(UnknownReason::FocusUnavailable)
                ),
                Focus::Password
            );
            assert_eq!(
                classify(bundle, 42, 42, None, Subrole::Value("AXSecureTextField")),
                Focus::Password
            );
        }
    }

    #[test]
    fn unreadable_custom_container_and_unproven_producer_roles_fail_closed() {
        for role in [
            None,
            Some("AXTextField"),
            Some("Custom"),
            Some("AXWindow"),
            Some("AXRow"),
            Some("AXGroup"),
        ] {
            assert_eq!(
                classify(TEXTEDIT, 42, 42, role, Subrole::Unsupported),
                Focus::Unknown
            );
        }
        for bundle in [
            "org.example.Editor",
            "com.apple.Safari",
            "com.google.Chrome.evil",
        ] {
            assert_eq!(
                classify(bundle, 42, 42, Some("AXTextArea"), Subrole::Unsupported),
                Focus::Unknown
            );
            assert_eq!(
                classify(
                    bundle,
                    42,
                    42,
                    Some("AXButton"),
                    Subrole::Value("AXCloseButton")
                ),
                Focus::Unknown
            );
        }
        let snapshot = FocusSnapshot::unknown(UnknownReason::FocusUnavailable);
        assert_eq!(snapshot.focus, Focus::Unknown);
        assert_eq!(snapshot.private_browsing, PrivateState::Unknown);
        assert_eq!(snapshot.call_or_screen_share, PrivacyProof::Unknown);
    }

    #[test]
    fn changed_pid_cannot_inherit_even_a_recognized_focus() {
        assert_eq!(
            classify(TEXTEDIT, 42, 43, Some("AXTextArea"), Subrole::Unsupported),
            Focus::Unknown
        );
        assert_eq!(
            classify(
                TEXTEDIT,
                42,
                43,
                Some("AXTextField"),
                Subrole::Value("AXSecureTextField")
            ),
            Focus::Unknown
        );
        assert_eq!(
            classify(
                TEXTEDIT,
                0,
                0,
                Some("AXButton"),
                Subrole::Value("AXCloseButton")
            ),
            Focus::Unknown
        );
    }

    #[test]
    fn only_standard_documented_role_pairs_are_ordinary() {
        assert_eq!(
            classify(
                TEXTEDIT,
                42,
                42,
                Some("AXTextField"),
                Subrole::Value("AXSearchField")
            ),
            Focus::Ordinary
        );
        assert_eq!(
            classify(
                TEXTEDIT,
                42,
                42,
                Some("AXButton"),
                Subrole::Value("AXCloseButton")
            ),
            Focus::Ordinary
        );
        assert_eq!(
            classify(
                TEXTEDIT,
                42,
                42,
                Some("AXTextField"),
                Subrole::Value("AXCloseButton")
            ),
            Focus::Unknown
        );
    }

    #[test]
    fn identity_includes_exact_bundle_and_launch_generation() {
        let app = ProcessIdentity {
            pid: 42,
            bundle_id: TEXTEDIT.into(),
            launch_time_bits: 1000f64.to_bits(),
        };
        let mut changed = app.clone();
        changed.launch_time_bits = 1001f64.to_bits();
        assert_ne!(app, changed);
        changed = app.clone();
        changed.bundle_id = "org.example.Other".into();
        assert_ne!(app, changed);
    }
    #[test]
    fn chrome_standard_focus_is_separate_from_bound_private_window_authorization() {
        assert_eq!(
            classify(
                "com.google.Chrome",
                42,
                42,
                Some("AXWebArea"),
                Subrole::Unsupported
            ),
            Focus::Ordinary
        );
        assert_eq!(
            classify(
                "com.google.Chrome",
                42,
                42,
                Some("AXTextField"),
                Subrole::Value("AXSecureTextField")
            ),
            Focus::Password
        );
        assert_eq!(
            classify(
                "com.google.Chrome",
                42,
                42,
                Some("AXTextField"),
                Subrole::Failed(UnknownReason::FocusUnavailable)
            ),
            Focus::Unknown
        );
        assert_eq!(
            classify(
                "com.google.Chrome",
                42,
                43,
                Some("AXWebArea"),
                Subrole::Unsupported
            ),
            Focus::Unknown
        );
    }
}
