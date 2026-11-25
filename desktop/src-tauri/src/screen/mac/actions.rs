//! Bounded native input primitives; not an IPC surface or a complete Hand runner.
//! Every submitted event requires fresh native authorization for the exact launch,
//! window, geometry, session generation and approved action. Unknown is denial.
//! No activation, clipboard access, process launch, prompts or provider calls.
//! Kept crate-private and intentionally not wired to a runner until positive native
//! policy/window proofs exist. Remove this scoped allowance when integration supplies them.
#![allow(dead_code)]

use super::{
    privacy::ProcessIdentity,
    target::{Point, Rect},
};
use crate::screen::privacy::Focus;
use std::time::{Duration, Instant};

// One scheduling quantum: full prose requires the caller to schedule future chunks,
// with fresh session authorization between them. Never split a Unicode scalar.
const MAX_UTF16: usize = 16;
const TOTAL_BUDGET: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BoundTarget {
    pub process: ProcessIdentity,
    pub window_id: u32,
    /// Global Quartz top-left points, NEVER capture pixels or AppKit bottom-left points.
    pub bounds: Rect,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PolicyProof {
    Allowed,
    Denied,
    Unknown,
}

/// Must be freshly obtained by native code; never deserialize this from a webview/model.
/// Positive policy includes blocked-app, private-window, call/share and session checks.
/// The Mac privacy snapshot alone cannot produce Allowed (private/call proofs unknown).
#[derive(Debug, Clone)]
pub(crate) struct Authorization {
    pub target: BoundTarget,
    pub focus: Focus,
    pub user_approved: bool,
    pub policy: PolicyProof,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Button {
    Primary,
    Secondary,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Shortcut {
    Find,
    AddressBar,
    NewTab,
    NewDocument,
    Save,
    ShiftTab,
    Back,
    DocumentStart,
    DocumentEnd,
}
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Action {
    Text(String),
    Move(Point),
    Click {
        point: Point,
        button: Button,
    },
    /// Bounded pixel deltas. Positive vertical scrolls upward, as Quartz specifies.
    Scroll {
        point: Point,
        vertical: i32,
        horizontal: i32,
    },
    Shortcut(Shortcut),
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Error {
    InvalidTarget,
    InvalidAction,
    Denied,
    Unknown,
    TargetChanged,
    AccessibilityUnavailable,
    KeysHeld,
    Cancelled,
    EventUnavailable,
    CleanupFailed,
    Deadline,
    Busy,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq)]
enum Event {
    Key {
        code: u16,
        units: Vec<u16>,
        down: bool,
        flags: u64,
    },
    Move(Point),
    Button {
        point: Point,
        button: Button,
        down: bool,
    },
    Scroll {
        point: Point,
        vertical: i32,
        horizontal: i32,
    },
}
trait Sink {
    fn preflight(&mut self, target: &BoundTarget) -> Result<(), Error>;
    fn post(&mut self, event: &Event) -> Result<(), Error>;
}

fn run<S: Sink, G: FnMut(&BoundTarget, &Action) -> Result<Authorization, Error>>(
    sink: &mut S,
    target: &BoundTarget,
    action: &Action,
    guard: &mut G,
) -> Result<usize, Error> {
    let started = Instant::now();
    run_with_clock(sink, target, action, guard, &mut || started.elapsed())
}

fn run_with_clock<
    S: Sink,
    G: FnMut(&BoundTarget, &Action) -> Result<Authorization, Error>,
    C: FnMut() -> Duration,
>(
    sink: &mut S,
    target: &BoundTarget,
    action: &Action,
    guard: &mut G,
    elapsed: &mut C,
) -> Result<usize, Error> {
    if target.process.pid <= 0
        || target.process.bundle_id.is_empty()
        || target.window_id == 0
        || !f64::from_bits(target.process.launch_time_bits).is_finite()
        || Rect::new(
            target.bounds.x,
            target.bounds.y,
            target.bounds.width,
            target.bounds.height,
        )
        .is_none()
    {
        return Err(Error::InvalidTarget);
    }
    let events = events(action, target.bounds)?;
    let mut held: Vec<Event> = Vec::new();
    let mut submitted = 0;
    for event in events {
        // The caller must freshly resolve the exact native focused window and geometry,
        // bind consent to THIS action, and reject unknown focus/private/call policy.
        let authorized = (|| {
            if elapsed() >= TOTAL_BUDGET {
                return Err(Error::Deadline);
            }
            let auth = guard(target, action)?;
            if elapsed() >= TOTAL_BUDGET {
                return Err(Error::Deadline);
            }
            if auth.target != *target {
                return Err(Error::TargetChanged);
            }
            if !auth.user_approved
                || auth.policy == PolicyProof::Denied
                || auth.focus == Focus::Password
            {
                return Err(Error::Denied);
            }
            if auth.policy != PolicyProof::Allowed || auth.focus != Focus::Ordinary {
                return Err(Error::Unknown);
            }
            sink.preflight(target)?;
            // AX calls cannot be preempted. Do not submit even this event if a bounded
            // native metadata read or the caller's guard consumed the whole quantum.
            if elapsed() >= TOTAL_BUDGET {
                return Err(Error::Deadline);
            }
            sink.post(&event)
        })();
        if let Err(error) = authorized {
            // Only matching UP events for DOWN events THIS run successfully submitted.
            // Release is the sole authorization exception, needed even after focus/consent
            // revocation. Never release an arbitrary physical key or button.
            let mut cleanup_failed = false;
            for release in held.iter().rev() {
                cleanup_failed |= sink.post(release).is_err();
            }
            return Err(if cleanup_failed {
                Error::CleanupFailed
            } else {
                error
            });
        }
        submitted += 1;
        match &event {
            Event::Key { down: true, .. } | Event::Button { down: true, .. } => {
                held.push(release_for(&event).expect("down event has release"));
            }
            Event::Key { down: false, .. } | Event::Button { down: false, .. } => {
                if let Some(index) = held.iter().rposition(|up| same_input(up, &event)) {
                    held.remove(index);
                }
            }
            _ => {}
        }
    }
    Ok(submitted)
}

fn same_input(a: &Event, b: &Event) -> bool {
    match (a, b) {
        (
            Event::Key {
                code: ac,
                units: au,
                ..
            },
            Event::Key {
                code: bc,
                units: bu,
                ..
            },
        ) => ac == bc && au == bu,
        (Event::Button { button: ab, .. }, Event::Button { button: bb, .. }) => ab == bb,
        _ => false,
    }
}
fn release_for(event: &Event) -> Option<Event> {
    match event {
        Event::Key {
            code,
            units,
            down: true,
            ..
        } => Some(Event::Key {
            code: *code,
            units: units.clone(),
            down: false,
            flags: 0,
        }),
        Event::Button {
            point,
            button,
            down: true,
        } => Some(Event::Button {
            point: *point,
            button: *button,
            down: false,
        }),
        _ => None,
    }
}
fn key_pair(result: &mut Vec<Event>, code: u16, units: Vec<u16>, flags: u64) {
    result.push(Event::Key {
        code,
        units: units.clone(),
        down: true,
        flags,
    });
    result.push(Event::Key {
        code,
        units,
        down: false,
        flags,
    });
}
fn events(action: &Action, bounds: Rect) -> Result<Vec<Event>, Error> {
    let mut result = Vec::new();
    let check_point = |point: Point| {
        if point.x.is_finite() && point.y.is_finite() && bounds.contains(point) {
            Ok(())
        } else {
            Err(Error::InvalidAction)
        }
    };
    match action {
        Action::Text(text) => {
            // Validate the ENTIRE bounded chunk before even the first character is submitted.
            // NUL and unexpected controls are refused, never silently truncated/dropped.
            if text.is_empty()
                || text.len() > MAX_UTF16 * 4
                || text.encode_utf16().count() > MAX_UTF16
                || text
                    .chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\t')
            {
                return Err(Error::InvalidAction);
            }
            for c in text.chars() {
                match c {
                    '\n' => key_pair(&mut result, 36, vec![], 0), // kVK_Return
                    '\t' => key_pair(&mut result, 48, vec![], 0), // kVK_Tab
                    _ => {
                        let mut buf = [0u16; 2];
                        key_pair(&mut result, 0, c.encode_utf16(&mut buf).to_vec(), 0);
                    }
                }
            }
        }
        Action::Move(point) => {
            check_point(*point)?;
            result.push(Event::Move(*point));
        }
        Action::Click { point, button } => {
            check_point(*point)?;
            result.push(Event::Button {
                point: *point,
                button: *button,
                down: true,
            });
            result.push(Event::Button {
                point: *point,
                button: *button,
                down: false,
            });
        }
        Action::Scroll {
            point,
            vertical,
            horizontal,
        } => {
            check_point(*point)?;
            if !(-1200..=1200).contains(vertical)
                || !(-1200..=1200).contains(horizontal)
                || (*vertical == 0 && *horizontal == 0)
            {
                return Err(Error::InvalidAction);
            }
            result.push(Event::Scroll {
                point: *point,
                vertical: *vertical,
                horizontal: *horizontal,
            });
        }
        Action::Shortcut(shortcut) => {
            // Same bounded intention as Windows mouse::PlainKey; no arbitrary virtual-key
            // API and no shell/close/delete/cut/paste/send shortcuts.
            let (modifier, flag, key) = match shortcut {
                Shortcut::Find => (55, 1 << 20, 3),         // Command-F
                Shortcut::AddressBar => (55, 1 << 20, 37),  // Command-L
                Shortcut::NewTab => (55, 1 << 20, 17),      // Command-T
                Shortcut::NewDocument => (55, 1 << 20, 45), // Command-N
                Shortcut::Save => (55, 1 << 20, 1),         // Command-S
                Shortcut::ShiftTab => (56, 1 << 17, 48),
                Shortcut::Back => (55, 1 << 20, 33), // Command-[
                Shortcut::DocumentStart => (55, 1 << 20, 126), // Command-Up
                Shortcut::DocumentEnd => (55, 1 << 20, 125), // Command-Down
            };
            result.push(Event::Key {
                code: modifier,
                units: vec![],
                down: true,
                flags: flag,
            });
            key_pair(&mut result, key, vec![], flag);
            result.push(Event::Key {
                code: modifier,
                units: vec![],
                down: false,
                flags: 0,
            });
        }
    }
    Ok(result)
}

/// Submit one bounded action with a mandatory fresh native policy callback per event.
/// Text is at most 16 UTF-16 units per call, preserving Unicode scalar boundaries.
/// A cumulative 100ms budget is checked before/after guard and after native preflight;
/// expiry stops submission and releases only owned input. Native AX calls retain their
/// own bounded timeouts and cannot be preempted, so this is not a strict 100ms wall-time
/// guarantee. The caller must keep its guard bounded and schedule future chunks on later
/// main-loop turns instead of looping synchronously here for a full paragraph.
/// Ok counts submissions to Quartz, NOT acknowledgement that the app accepted an action:
/// CGEventPost returns void. Callers must observe/verify resulting application state.
/// Err can follow partial submission; do not retry a failed action as if nothing happened.
/// CleanupFailed means at least one owned release could not be submitted (e.g. OS trust
/// revoked); permission loss is never bypassed to force a release.
/// Invoke from native code on the AppKit main thread (privacy metadata requires it).
/// The callback must independently verify the exact AX focused window ID, current bounds,
/// ordinary field, launch identity, generation, explicit user intent and positive policy.
/// For pointer actions it must also AX hit-test the exact point and reject protected or
/// unknown destination elements and occluding windows. Focus alone does not prove a click safe.
/// It must fail closed when the native focus/private/call proof is unavailable.
/// This is deliberately NOT a tauri::command and has no Serialize/Deserialize derives.
#[cfg(all(target_os = "macos", not(test)))]
pub(crate) fn perform<G: FnMut(&BoundTarget, &Action) -> Result<Authorization, Error>>(
    target: &BoundTarget,
    action: &Action,
    mut guard: G,
) -> Result<usize, Error> {
    static ACTIVE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    // Avoid overlapping injected state; never wait with the AppKit main thread blocked.
    let _lease = ACTIVE.try_lock().map_err(|_| Error::Busy)?;
    run(&mut native::Native, target, action, &mut guard)
}

#[cfg(all(target_os = "macos", not(test)))]
mod native {
    use super::*;
    use std::{ffi::c_void, ptr};
    type Cf = *const c_void;
    // Signatures/constants verified in the local macOS SDK CGEvent{,Source,Types}.h
    // and Carbon/HIToolbox Events.h. CGEventPost is void: no delivery claim is made.
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightPostEventAccess() -> bool;
        fn CGEventCreateKeyboardEvent(source: Cf, key: u16, down: bool) -> Cf;
        fn CGEventKeyboardSetUnicodeString(event: Cf, length: usize, units: *const u16);
        fn CGEventSetFlags(event: Cf, flags: u64);
        fn CGEventCreateMouseEvent(source: Cf, kind: u32, point: Point, button: u32) -> Cf;
        fn CGEventCreateScrollWheelEvent2(
            source: Cf,
            units: u32,
            wheels: u32,
            vertical: i32,
            horizontal: i32,
            third: i32,
        ) -> Cf;
        fn CGEventSetLocation(event: Cf, point: Point);
        fn CGEventPost(tap: u32, event: Cf);
        fn CGEventSourceFlagsState(state: i32) -> u64;
        fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
        fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: Cf);
    }
    struct Owned(Cf);
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) };
        }
    }
    pub(super) struct Native;
    impl Sink for Native {
        fn preflight(&mut self, target: &BoundTarget) -> Result<(), Error> {
            if !super::super::privacy::accessibility_trusted()
                || !unsafe { CGPreflightPostEventAccess() }
            {
                return Err(Error::AccessibilityUnavailable);
            }
            let focus = super::super::privacy::snapshot(&target.process);
            if focus.focus != Focus::Ordinary {
                return Err(if focus.focus == Focus::Password {
                    Error::Denied
                } else {
                    Error::Unknown
                });
            }
            // A candidate window is NOT an AX focused-window proof. This additional z-order
            // check detects disappearance/movement; the caller still owes exact AX binding.
            let windows = super::super::target::visible_windows().ok_or(Error::Unknown)?;
            if !windows.iter().any(|w| {
                w.id == target.window_id
                    && w.pid == target.process.pid
                    && w.bounds == target.bounds
                    && w.layer == 0
            }) {
                return Err(Error::TargetChanged);
            }
            // HID source state only; our own session-injected modifiers must not look like
            // the student's physical modifiers. CapsLock/Fn also refuse injection.
            let flags = unsafe { CGEventSourceFlagsState(1) };
            if flags & ((1 << 16) | (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20) | (1 << 23)) != 0
                || (0..3).any(|button| unsafe { CGEventSourceButtonState(1, button) })
            {
                return Err(Error::KeysHeld);
            }
            if unsafe { CGEventSourceKeyState(1, 53) } {
                return Err(Error::Cancelled);
            }
            Ok(())
        }
        fn post(&mut self, event: &Event) -> Result<(), Error> {
            // Even cleanup never requests permissions and never bypasses OS permission loss.
            if !super::super::privacy::accessibility_trusted()
                || !unsafe { CGPreflightPostEventAccess() }
            {
                return Err(Error::AccessibilityUnavailable);
            }
            let raw = unsafe {
                match event {
                    Event::Key {
                        code,
                        units,
                        down,
                        flags,
                    } => {
                        let raw = CGEventCreateKeyboardEvent(ptr::null(), *code, *down);
                        if !raw.is_null() {
                            CGEventSetFlags(raw, *flags);
                            if !units.is_empty() {
                                CGEventKeyboardSetUnicodeString(raw, units.len(), units.as_ptr());
                            }
                        }
                        raw
                    }
                    Event::Move(point) => CGEventCreateMouseEvent(ptr::null(), 5, *point, 0),
                    Event::Button {
                        point,
                        button,
                        down,
                    } => {
                        let (kind, button) = match (button, down) {
                            (Button::Primary, true) => (1, 0),
                            (Button::Primary, false) => (2, 0),
                            (Button::Secondary, true) => (3, 1),
                            (Button::Secondary, false) => (4, 1),
                        };
                        CGEventCreateMouseEvent(ptr::null(), kind, *point, button)
                    }
                    Event::Scroll {
                        point,
                        vertical,
                        horizontal,
                    } => {
                        let raw = CGEventCreateScrollWheelEvent2(
                            ptr::null(),
                            0,
                            2,
                            *vertical,
                            *horizontal,
                            0,
                        );
                        if !raw.is_null() {
                            CGEventSetLocation(raw, *point);
                        }
                        raw
                    }
                }
            };
            if raw.is_null() {
                return Err(Error::EventUnavailable);
            }
            let owned = Owned(raw);
            // Session tap = 1, so generated events do not enter HID physical source state.
            // No hooks/taps are installed; this only submits the already guarded event.
            unsafe { CGEventPost(1, owned.0) };
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake {
        posts: Vec<Event>,
        preflights: usize,
        fail_at: Option<usize>,
    }
    impl Sink for Fake {
        fn preflight(&mut self, _: &BoundTarget) -> Result<(), Error> {
            self.preflights += 1;
            if self.fail_at == Some(self.preflights) {
                Err(Error::Cancelled)
            } else {
                Ok(())
            }
        }
        fn post(&mut self, event: &Event) -> Result<(), Error> {
            self.posts.push(event.clone());
            Ok(())
        }
    }
    fn target() -> BoundTarget {
        BoundTarget {
            process: ProcessIdentity {
                pid: 42,
                bundle_id: "org.example.Test".into(),
                launch_time_bits: 1.0f64.to_bits(),
            },
            window_id: 9,
            bounds: Rect::new(-100., 0., 200., 200.).unwrap(),
            generation: 7,
        }
    }
    fn approved(t: &BoundTarget, _: &Action) -> Result<Authorization, Error> {
        Ok(Authorization {
            target: t.clone(),
            focus: Focus::Ordinary,
            user_approved: true,
            policy: PolicyProof::Allowed,
        })
    }
    #[test]
    fn unicode_keeps_surrogates_together_and_maps_only_explicit_controls() {
        let mut fake = Fake::default();
        assert_eq!(
            run(
                &mut fake,
                &target(),
                &Action::Text("é😀\n\t".into()),
                &mut approved
            ),
            Ok(8)
        );
        assert!(
            matches!(&fake.posts[2], Event::Key { units, down: true, .. } if units == &[0xd83d, 0xde00])
        );
        assert!(matches!(&fake.posts[4], Event::Key { code: 36, units, .. } if units.is_empty()));
        assert!(matches!(&fake.posts[6], Event::Key { code: 48, units, .. } if units.is_empty()));
    }
    #[test]
    fn all_uncertain_or_denied_authorizations_post_nothing() {
        for (focus, policy, approved_flag) in [
            (Focus::Unknown, PolicyProof::Allowed, true),
            (Focus::Password, PolicyProof::Allowed, true),
            (Focus::Ordinary, PolicyProof::Unknown, true),
            (Focus::Ordinary, PolicyProof::Denied, true),
            (Focus::Ordinary, PolicyProof::Allowed, false),
        ] {
            let mut fake = Fake::default();
            let result = run(
                &mut fake,
                &target(),
                &Action::Text("x".into()),
                &mut |t, a| {
                    let mut auth = approved(t, a)?;
                    auth.focus = focus;
                    auth.policy = policy;
                    auth.user_approved = approved_flag;
                    Ok(auth)
                },
            );
            assert!(result.is_err());
            assert!(fake.posts.is_empty());
        }
    }
    #[test]
    fn changed_launch_window_geometry_or_generation_cannot_inherit_approval() {
        for changed in 0..5 {
            let mut fake = Fake::default();
            let result = run(
                &mut fake,
                &target(),
                &Action::Shortcut(Shortcut::Save),
                &mut |t, a| {
                    let mut auth = approved(t, a)?;
                    match changed {
                        0 => auth.target.process.launch_time_bits += 1,
                        1 => auth.target.window_id += 1,
                        2 => auth.target.bounds.x += 1.,
                        3 => auth.target.generation += 1,
                        _ => auth.target.process.bundle_id.push('x'),
                    }
                    Ok(auth)
                },
            );
            assert_eq!(result, Err(Error::TargetChanged));
            assert!(fake.posts.is_empty());
        }
    }
    #[test]
    fn revocation_releases_only_owned_keys_and_does_not_continue() {
        let mut fake = Fake::default();
        let mut checks = 0;
        let result = run(
            &mut fake,
            &target(),
            &Action::Shortcut(Shortcut::Save),
            &mut |t, a| {
                checks += 1;
                if checks == 3 {
                    Err(Error::Cancelled)
                } else {
                    approved(t, a)
                }
            },
        );
        assert_eq!(result, Err(Error::Cancelled));
        assert_eq!(fake.posts.len(), 4);
        assert!(matches!(
            &fake.posts[0],
            Event::Key {
                code: 55,
                down: true,
                ..
            }
        ));
        assert!(matches!(
            &fake.posts[1],
            Event::Key {
                code: 1,
                down: true,
                ..
            }
        ));
        assert!(matches!(
            &fake.posts[2],
            Event::Key {
                code: 1,
                down: false,
                flags: 0,
                ..
            }
        ));
        assert!(matches!(
            &fake.posts[3],
            Event::Key {
                code: 55,
                down: false,
                flags: 0,
                ..
            }
        ));
    }
    #[test]
    fn preflight_revocation_releases_own_button() {
        let mut fake = Fake {
            fail_at: Some(2),
            ..Fake::default()
        };
        let action = Action::Click {
            point: Point { x: -20., y: 10. },
            button: Button::Primary,
        };
        assert_eq!(
            run(&mut fake, &target(), &action, &mut approved),
            Err(Error::Cancelled)
        );
        assert_eq!(fake.posts.len(), 2);
        assert!(matches!(&fake.posts[0], Event::Button { down: true, .. }));
        assert!(matches!(&fake.posts[1], Event::Button { down: false, .. }));
    }
    #[test]
    fn invalid_text_coordinates_and_scroll_never_post() {
        for action in [
            Action::Text("a\0b".into()),
            Action::Text("a\u{1b}".into()),
            Action::Text("x".repeat(MAX_UTF16 + 1)),
            Action::Text("😀".repeat(MAX_UTF16 / 2 + 1)),
            Action::Move(Point { x: f64::NAN, y: 0. }),
            Action::Move(Point { x: 100., y: 0. }),
            Action::Scroll {
                point: Point { x: 0., y: 0. },
                vertical: i32::MIN,
                horizontal: 0,
            },
        ] {
            let mut fake = Fake::default();
            assert_eq!(
                run(&mut fake, &target(), &action, &mut approved),
                Err(Error::InvalidAction)
            );
            assert!(fake.posts.is_empty());
        }
    }
    #[test]
    fn valid_negative_origin_move_and_scroll_are_guarded() {
        for action in [
            Action::Move(Point { x: -50., y: 0. }),
            Action::Scroll {
                point: Point { x: -50., y: 0. },
                vertical: 40,
                horizontal: -10,
            },
        ] {
            let mut fake = Fake::default();
            let mut calls = 0;
            assert_eq!(
                run(&mut fake, &target(), &action, &mut |t, a| {
                    calls += 1;
                    approved(t, a)
                }),
                Ok(1)
            );
            assert_eq!(calls, 1);
            assert_eq!(fake.preflights, 1);
        }
    }
    #[test]
    fn text_chunks_stop_at_sixteen_utf16_units_without_splitting_scalars() {
        let mut fake = Fake::default();
        let over = Action::Text(format!("{}😀", "x".repeat(15)));
        assert_eq!(
            run(&mut fake, &target(), &over, &mut approved),
            Err(Error::InvalidAction)
        );
        assert!(fake.posts.is_empty());
        let exact = Action::Text(format!("{}😀", "x".repeat(14)));
        assert_eq!(run(&mut fake, &target(), &exact, &mut approved), Ok(30));
        assert!(
            matches!(&fake.posts[28], Event::Key { units, down: true, .. } if units == &[0xd83d,0xde00])
        );
    }
    #[test]
    fn deadline_after_native_preflight_releases_own_key_without_posting_next_down() {
        use std::{cell::Cell, rc::Rc};
        struct SlowSink {
            fake: Fake,
            time: Rc<Cell<Duration>>,
        }
        impl Sink for SlowSink {
            fn preflight(&mut self, target: &BoundTarget) -> Result<(), Error> {
                self.time.set(self.time.get() + Duration::from_millis(60));
                self.fake.preflight(target)
            }
            fn post(&mut self, event: &Event) -> Result<(), Error> {
                self.fake.post(event)
            }
        }
        let time = Rc::new(Cell::new(Duration::ZERO));
        let mut sink = SlowSink {
            fake: Fake::default(),
            time: time.clone(),
        };
        let result = run_with_clock(
            &mut sink,
            &target(),
            &Action::Text("ab".into()),
            &mut approved,
            &mut || time.get(),
        );
        assert_eq!(result, Err(Error::Deadline));
        assert_eq!(sink.fake.posts.len(), 2);
        assert!(
            matches!(&sink.fake.posts[0], Event::Key { units, down: true, .. } if units == &[97])
        );
        assert!(
            matches!(&sink.fake.posts[1], Event::Key { units, down: false, flags: 0, .. } if units == &[97])
        );
    }
    #[test]
    fn deadline_during_authorization_never_posts() {
        use std::cell::Cell;
        let time = Cell::new(Duration::ZERO);
        let mut fake = Fake::default();
        let result = run_with_clock(
            &mut fake,
            &target(),
            &Action::Shortcut(Shortcut::Save),
            &mut |t, a| {
                time.set(Duration::from_secs(1));
                approved(t, a)
            },
            &mut || time.get(),
        );
        assert_eq!(result, Err(Error::Deadline));
        assert!(fake.posts.is_empty());
        assert_eq!(fake.preflights, 0);
    }
}
