//! Bind extension window identities to native process launches and unique Quartz windows.
//! Browser IDs are never treated as CGWindowIDs. No metadata from this module alone grants
//! screen capture: callers still run the existing focus, password, call and redaction policy.
use super::{capture_session, pipeline::Target, runtime, target};
use crate::{browser_companion_protocol as wire, browser_companion_server as broker};
use std::sync::{atomic::Ordering, mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

#[derive(Clone)]
struct Binding {
    connection: String,
    target: Target,
    window: wire::Window,
}
pub struct Bridge {
    pub server: Arc<broker::Server>,
    bindings: Mutex<Vec<Binding>>,
}
pub fn setup(app: &AppHandle) -> Result<(), String> {
    let server = broker::start().map_err(|_| "Couldn't start the local browser companion.")?;
    if !app.manage(Bridge {
        server,
        bindings: Mutex::new(Vec::new()),
    }) {
        return Err("Browser companion already initialized.".into());
    }
    Ok(())
}
fn live(app: &AppHandle, generation: u64) -> bool {
    runtime::of(app).is_ok_and(|r| {
        let (config, reset) = r.snapshot();
        !reset
            && config.is_on()
            && !config.paused
            && r.generation.load(Ordering::Acquire) == generation
    })
}
fn on_main(
    app: &AppHandle,
    expected: &Target,
    generation: u64,
    retained: bool,
    browser: Option<wire::Window>,
) -> bool {
    let expected = expected.clone();
    let handle = app.clone();
    let (tx, rx) = mpsc::sync_channel(1);
    let deadline = Instant::now() + Duration::from_millis(450);
    if app
        .run_on_main_thread(move || {
            let valid = Instant::now() < deadline
                && live(&handle, generation)
                && browser.as_ref().is_none_or(|window| {
                    target::visible_windows()
                        .is_some_and(|windows| unique_mapping(window, &expected, &windows))
                })
                && (capture_session::target_is_current_main(&handle, &expected, generation)
                    || retained
                        && capture_session::stored_target_current_main(
                            &handle, &expected, generation,
                        ));
            let _ = tx.send(valid);
        })
        .is_err()
    {
        return false;
    }
    rx.recv_timeout(Duration::from_millis(450)).unwrap_or(false)
}
fn bounds_match(window: &wire::Window, bounds: target::Rect) -> bool {
    // WebExtension windows use global top-left logical pixels. Permit integer rounding only;
    // never scale Retina coordinates or use the browser's ID as an OS window handle.
    [
        window.left - bounds.x,
        window.top - bounds.y,
        window.width - bounds.width,
        window.height - bounds.height,
    ]
    .iter()
    .all(|delta| delta.is_finite() && delta.abs() <= 1.)
}
/// Rounding tolerance must also be applied to the whole native inventory. Two almost
/// coincident windows are just as ambiguous as two exactly coincident windows.
pub(crate) fn unique_mapping(
    window: &wire::Window,
    expected: &Target,
    windows: &[target::WindowSnapshot],
) -> bool {
    let mut candidates = windows.iter().filter(|w| {
        w.pid == expected.process.pid && w.layer == 0 && bounds_match(window, w.bounds)
    });
    candidates
        .next()
        .is_some_and(|w| w.id == expected.window_id && w.bounds == expected.quartz_points)
        && candidates.next().is_none()
}
/// Worker only. A fresh focused probe can establish a mapping; retained operations can only
/// refresh an existing mapping to the same launch, CG window, browser tab and document.
pub fn probe(
    app: &AppHandle,
    expected: &Target,
    generation: u64,
    retained: bool,
) -> Option<wire::Window> {
    if objc2::MainThreadMarker::new().is_some()
        || !live(app, generation)
        || !on_main(app, expected, generation, retained, None)
    {
        return None;
    }
    let bridge = app.try_state::<Bridge>()?;
    let connections = bridge.server.status();
    let connections: Vec<_> = connections
        .into_iter()
        .filter(|c| {
            c.trusted
                && c.browser_pid == expected.process.pid
                && c.browser_identifier == expected.process.bundle_id
        })
        .collect();
    // Multiple profiles in one browser process must not inherit one another's proof.
    let [connection] = connections.as_slice() else {
        return None;
    };
    let previous = bridge
        .bindings
        .lock()
        .ok()?
        .iter()
        .find(|b| b.connection == connection.connection_id && b.target == *expected)
        .cloned();
    let scope = if retained {
        let b = previous?;
        broker::Target {
            window_id: Some(b.window.id),
            tab_id: Some(b.window.tab.id),
            document_id: Some(b.window.tab.document_id),
            ..Default::default()
        }
    } else {
        broker::Target::default()
    };
    let response = bridge
        .server
        .request(
            &connection.connection_id,
            generation,
            wire::Operation::Probe,
            scope,
        )
        .ok()?;
    let window = response
        .window
        .filter(|_| response.status == wire::Status::Ok)?;
    if window.incognito
        || (!retained && !window.focused)
        || !bounds_match(&window, expected.quartz_points)
        || !on_main(app, expected, generation, retained, Some(window.clone()))
        || !live(app, generation)
    {
        return None;
    }
    let mut bindings = bridge.bindings.lock().ok()?;
    bindings.retain(|b| {
        b.connection != connection.connection_id || b.target.window_id != expected.window_id
    });
    if bindings.len() >= 32 {
        bindings.remove(0);
    }
    bindings.push(Binding {
        connection: connection.connection_id.clone(),
        target: expected.clone(),
        window: window.clone(),
    });
    Some(window)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_geometry_is_logical_and_only_rounding_is_tolerated() {
        let mut w = wire::Window {
            id: 99,
            focused: true,
            incognito: false,
            left: -1440.,
            top: 20.,
            width: 1000.,
            height: 800.,
            tab: wire::Tab {
                id: 3,
                url: String::new(),
                title: String::new(),
                document_id: "1".repeat(32),
            },
        };
        let b = target::Rect::new(-1440., 20., 1000., 800.).unwrap();
        assert!(bounds_match(&w, b));
        w.left += 1.;
        assert!(bounds_match(&w, b));
        w.left += 1.;
        assert!(!bounds_match(&w, b));
        w.left = -2880.;
        w.width = 2000.;
        assert!(!bounds_match(&w, b));
        w.left = -1440.;
        w.width = 1000.;
        let expected = Target {
            window_id: 4,
            process: super::super::privacy::ProcessIdentity {
                pid: 42,
                bundle_id: "org.mozilla.firefox".into(),
                launch_time_bits: 1f64.to_bits(),
            },
            quartz_points: b,
        };
        let first = target::WindowSnapshot {
            id: 4,
            pid: 42,
            bounds: b,
            layer: 0,
            alpha: None,
        };
        assert!(unique_mapping(&w, &expected, std::slice::from_ref(&first)));
        let second = target::WindowSnapshot {
            id: 5,
            bounds: target::Rect::new(b.x + 0.5, b.y, b.width, b.height).unwrap(),
            ..first.clone()
        };
        assert!(!unique_mapping(&w, &expected, &[first, second]));
        w.left = f64::NAN;
        assert!(!bounds_match(&w, b));
    }
}

/// Native-only connection lookup. A remote/model cannot supply this authority.
pub fn bound_connection(app: &AppHandle, expected: &Target) -> Option<String> {
    let bridge = app.try_state::<Bridge>()?;
    let bindings = bridge.bindings.lock().ok()?;
    let binding = bindings.iter().find(|b| b.target == *expected)?;
    bridge
        .server
        .status()
        .iter()
        .any(|c| {
            c.trusted
                && c.connection_id == binding.connection
                && c.browser_pid == expected.process.pid
                && c.browser_identifier == expected.process.bundle_id
        })
        .then(|| binding.connection.clone())
}
/// Worker-side discovery, with AppKit and AX reads dispatched to the main queue.
pub fn focused_target(app: &AppHandle) -> Option<Target> {
    if objc2::MainThreadMarker::new().is_some() {
        return None;
    }
    let handle = app.clone();
    let (tx, rx) = mpsc::sync_channel(1);
    let deadline = Instant::now() + Duration::from_millis(450);
    app.run_on_main_thread(move || {
        let result = (|| {
            let process = super::privacy::frontmost_process_identity()?;
            let identity = target::AppIdentity {
                pid: process.pid,
                bundle_id: Some(process.bundle_id.clone()),
            };
            let window = target::frontmost_window_candidate(&identity)?;
            let windows = target::visible_windows()?;
            if windows
                .iter()
                .filter(|w| w.pid == process.pid && w.layer == 0 && w.bounds == window.bounds)
                .count()
                != 1
                || !capture_session::binding::focused_window_matches(process.pid, window.bounds)
                || super::privacy::frontmost_process_identity().as_ref() != Some(&process)
                || Instant::now() >= deadline
            {
                return None;
            }
            let _ = handle;
            Some(Target {
                window_id: window.id,
                process,
                quartz_points: window.bounds,
            })
        })();
        let _ = tx.send(result);
    })
    .ok()?;
    rx.recv_timeout(Duration::from_millis(450)).ok().flatten()
}
#[derive(serde::Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum SettingsAction {
    Status,
    Install {
        browser: crate::browser_companion_install::Browser,
    },
    Uninstall {
        browser: crate::browser_companion_install::Browser,
    },
    Approve {
        id: String,
    },
    Revoke {
        id: String,
    },
}
#[tauri::command]
pub fn mac_browser_companion(
    window: tauri::WebviewWindow,
    action: SettingsAction,
) -> Result<serde_json::Value, String> {
    super::settings::require_settings_window(&window)?;
    let app = window.app_handle();
    let bridge = app
        .try_state::<Bridge>()
        .ok_or("Browser companion is unavailable. Restart Neb to retry.")?;
    match action {
        SettingsAction::Status => {},
        SettingsAction::Install { browser } => crate::browser_companion_install::set(browser, true).map_err(|_| "Couldn't install the browser host. Run Neb from its installed app bundle and check the guide.")?,
        SettingsAction::Uninstall { browser } => crate::browser_companion_install::set(browser, false).map_err(|_| "Couldn't remove this browser host registration.")?,
        SettingsAction::Approve { id } => bridge.server.approve(&id).map_err(|_| "Couldn't approve this browser profile.")?,
        SettingsAction::Revoke { id } => bridge.server.revoke_pairing(&id).map_err(|_| "Couldn't revoke this browser profile.")?,
    }
    Ok(
        serde_json::json!({ "pending": bridge.server.pending(), "connections": bridge.server.status(), "pairings": bridge.server.pairings() }),
    )
}

/// Optional website playback metadata for an already authorized capture target. The panel's
/// media permission is not reused as capture authority, and provider content stays unchanged.
pub(crate) fn playback(
    app: &AppHandle,
    expected: &Target,
    generation: u64,
) -> Option<super::media::PlaybackSnapshot> {
    let window = probe(app, expected, generation, false)?;
    let connection = bound_connection(app, expected)?;
    let bridge = app.try_state::<Bridge>()?;
    let response = bridge
        .server
        .request(
            &connection,
            generation,
            wire::Operation::Media,
            broker::Target {
                window_id: Some(window.id),
                tab_id: Some(window.tab.id),
                document_id: Some(window.tab.document_id.clone()),
                ..Default::default()
            },
        )
        .ok()?;
    if response.status != wire::Status::Ok {
        return None;
    }
    let returned = response.window?;
    if !on_main(app, expected, generation, false, Some(returned.clone())) {
        return None;
    }
    if !bounds_match(&returned, expected.quartz_points) || returned.tab.url != window.tab.url {
        return None;
    }
    let media = response.media?;
    Some(super::media::PlaybackSnapshot {
        playing: media.playing,
        position_sec: Some(media.position_sec.floor() as u32),
        source_url: crate::screen::source::sanitize_url(&returned.tab.url)?.to_string(),
    })
}
