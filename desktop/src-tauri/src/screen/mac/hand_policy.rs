//! Native per-event action authorization. Positive capture policy is checked again at the
//! mutation boundary. The webview/model cannot supply or deserialize an Authorization.
use crate::screen::mac::hand_policy_ax as ax;
use crate::screen::mac::{
    actions::{Action, Authorization, BoundTarget, Error, PolicyProof},
    app_policy, call_signals, privacy, runtime, target,
};
use crate::screen::privacy::Focus;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// Native-only lease minted after Hand's full privacy revalidation on its worker. It is
/// scoped to one <=100ms input quantum, never supplied by a model or webview.
pub(crate) struct BrowserLease {
    target: BoundTarget,
    issued: Instant,
}
impl BrowserLease {
    pub(crate) fn after_verified_target(target: &BoundTarget) -> Self {
        Self {
            target: target.clone(),
            issued: Instant::now(),
        }
    }
    fn matches(&self, target: &BoundTarget) -> bool {
        self.target == *target && self.issued.elapsed() < Duration::from_millis(100)
    }
}
pub(crate) fn authorize(
    app: &AppHandle,
    expected: &BoundTarget,
    action: &Action,
    label: Option<&str>,
    browser: Option<&BrowserLease>,
) -> Result<Authorization, Error> {
    if objc2::MainThreadMarker::new().is_none() {
        return Err(Error::Denied);
    }
    let deadline = Instant::now() + Duration::from_millis(85);
    let runtime = runtime::of(app).map_err(|_| Error::Denied)?;
    let (config, reset) = runtime.snapshot();
    if reset
        || !config.is_on()
        || config.paused
        || !config.privacy.let_neb_click
        || !config.privacy.show_in_captures
        || runtime.generation.load(Ordering::Acquire) != expected.generation
    {
        return Err(Error::Cancelled);
    }
    if !privacy::accessibility_trusted() {
        return Err(Error::AccessibilityUnavailable);
    }
    let browser_valid = app_policy::has_inspected_browser_dictionary(&expected.process.bundle_id)
        && browser.is_some_and(|lease| lease.matches(expected));
    if (app_policy::classify_app(&expected.process.bundle_id)
        != app_policy::AppClass::SupportedNative
        && !browser_valid)
        || app_policy::blocked_app(&expected.process.bundle_id, &config.privacy.blocked_apps)
            .is_some()
    {
        return Err(Error::Denied);
    }
    if privacy::frontmost_process_identity().as_ref() != Some(&expected.process) {
        return Err(Error::TargetChanged);
    }
    let app_identity = target::AppIdentity {
        pid: expected.process.pid,
        bundle_id: Some(expected.process.bundle_id.clone()),
    };
    let window = target::frontmost_window_candidate(&app_identity).ok_or(Error::TargetChanged)?;
    if window.id != expected.window_id || window.bounds != expected.bounds {
        return Err(Error::TargetChanged);
    }
    let focus = privacy::snapshot(&expected.process);
    if focus.focus != Focus::Ordinary
        || !(focus.private_browsing == app_policy::PrivateState::NotApplicableSupportedNative
            || browser_valid
                && focus.private_browsing == app_policy::PrivateState::RequiresBrowserEvidence)
    {
        return Err(Error::Unknown);
    }
    if config.privacy.pause_during_calls {
        let valid = || {
            Instant::now() < deadline
                && runtime.generation.load(Ordering::Acquire) == expected.generation
        };
        if call_signals::sample(deadline, &valid).state
            != call_signals::SignalState::KnownSignalsIdle
        {
            return Err(Error::Unknown);
        }
    }
    let point = match action {
        Action::Move(point) | Action::Click { point, .. } | Action::Scroll { point, .. } => {
            Some(*point)
        }
        _ => None,
    };
    if let Some(point) = point {
        let windows = target::visible_windows().ok_or(Error::Unknown)?;
        if !uncovered(&windows, expected, point, std::process::id() as i32) {
            return Err(Error::TargetChanged);
        }
    }
    if !ax::matches(expected, point, label, action, deadline) {
        return Err(Error::TargetChanged);
    }
    if Instant::now() >= deadline
        || runtime.generation.load(Ordering::Acquire) != expected.generation
        || privacy::frontmost_process_identity().as_ref() != Some(&expected.process)
    {
        return Err(Error::Cancelled);
    }
    if browser_valid && !browser.is_some_and(|lease| lease.matches(expected)) {
        return Err(Error::Deadline);
    }
    Ok(Authorization {
        target: expected.clone(),
        focus: Focus::Ordinary,
        user_approved: true,
        policy: PolicyProof::Allowed,
    })
}

fn uncovered(
    windows: &[target::WindowSnapshot],
    expected: &BoundTarget,
    point: target::Point,
    neb_pid: i32,
) -> bool {
    windows
        .iter()
        .find(|w| w.pid != neb_pid && w.bounds.contains(point) && w.alpha != Some(0.))
        .is_some_and(|w| {
            w.id == expected.window_id
                && w.pid == expected.process.pid
                && w.bounds == expected.bounds
        })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_lease_cannot_authorize_another_window_launch_generation_or_expired_quantum() {
        let target = BoundTarget {
            process: privacy::ProcessIdentity {
                pid: 42,
                bundle_id: "com.google.Chrome".into(),
                launch_time_bits: 1.0f64.to_bits(),
            },
            window_id: 7,
            bounds: target::Rect::new(0., 0., 800., 600.).unwrap(),
            generation: 4,
        };
        let lease = BrowserLease::after_verified_target(&target);
        assert!(lease.matches(&target));
        let mut changed = target.clone();
        changed.window_id += 1;
        assert!(!lease.matches(&changed));
        changed = target.clone();
        changed.generation += 1;
        assert!(!lease.matches(&changed));
        changed = target.clone();
        changed.process.launch_time_bits = 2.0f64.to_bits();
        assert!(!lease.matches(&changed));
        let stale = BrowserLease {
            target: target.clone(),
            issued: Instant::now() - Duration::from_millis(101),
        };
        assert!(!stale.matches(&target));
    }
    #[test]
    fn refuses_occluded_click_destinations_even_when_focus_stays_in_document() {
        let bounds = target::Rect::new(-400., 0., 300., 200.).unwrap();
        let expected = BoundTarget {
            process: privacy::ProcessIdentity {
                pid: 5,
                bundle_id: "com.apple.TextEdit".into(),
                launch_time_bits: 1f64.to_bits(),
            },
            window_id: 1,
            bounds,
            generation: 0,
        };
        let own = target::WindowSnapshot {
            id: 9,
            pid: 99,
            bounds,
            layer: 25,
            alpha: Some(1.),
        };
        let document = target::WindowSnapshot {
            id: 1,
            pid: 5,
            bounds,
            layer: 0,
            alpha: Some(1.),
        };
        let point = target::Point { x: -300., y: 50. };
        assert!(uncovered(&[own, document], &expected, point, 99));
        let notification = target::WindowSnapshot {
            id: 3,
            pid: 7,
            bounds,
            layer: 25,
            alpha: Some(1.),
        };
        let document = target::WindowSnapshot {
            id: 1,
            pid: 5,
            bounds,
            layer: 0,
            alpha: Some(1.),
        };
        assert!(!uncovered(&[notification, document], &expected, point, 99));
        assert!(!uncovered(&[], &expected, point, 99));
    }
}
