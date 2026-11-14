//! Keeping the desktop app up to date. The web app updates itself with each deploy; this is for the
//! native shell around it (docs: desktop/README.md, "Releasing an update").
//!
//! A release is a `latest.json` on a public https host, naming a newer version, its installer and
//! the installer's signature. The app fetches it soon after start, then every few hours; downloads
//! a newer version in the background (the updater plugin checks the signature against the public
//! key built in, and only accepts a greater version); then waits for the student to choose
//! "Restart to update" in the tray or on the settings page. A student mid-lesson is never restarted.
//!
//! Only the bundled settings page may call the commands below, which re-check its window; the
//! plugin's own commands are granted to no page.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Url, WebviewWindow, Wry};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::screen::coach::{require_settings_window, SETTINGS_WINDOW};

const FIRST_CHECK_AFTER: Duration = Duration::from_secs(30);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// For the check and the download together, on a slow connection.
const TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CHANGED_SCRIPT: &str = "window.dispatchEvent(new Event('neb:update-changed'))";

/// Where this build looks for updates and whose signature it accepts.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Source {
    pubkey: String,
    manifest: Url,
}

/// Both values are needed, and only https is accepted. Anything else means no updates.
fn source(pubkey: Option<&str>, manifest: Option<&str>) -> Option<Source> {
    let pubkey = pubkey?.trim();
    let manifest = Url::parse(manifest?.trim()).ok()?;
    (!pubkey.is_empty() && manifest.scheme() == "https").then(|| Source {
        pubkey: pubkey.to_owned(),
        manifest,
    })
}

/// What `tauri.release.conf.json` built in. Debug builds never update: there's nothing installed
/// to replace.
fn built_in_source(app: &AppHandle<Wry>) -> Option<Source> {
    if cfg!(debug_assertions) {
        return None;
    }
    let config = app.config().plugins.0.get("updater")?;
    source(
        config.get("pubkey")?.as_str(),
        config.get("endpoints")?.get(0)?.as_str(),
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Phase {
    /// This build doesn't update itself.
    Off,
    Idle,
    Checking,
    UpToDate,
    Downloading {
        version: String,
        percent: Option<u8>,
    },
    Ready {
        version: String,
    },
    Failed,
}

impl Phase {
    /// A new check would start from here (not while one runs, or with a version waiting).
    fn may_check(&self) -> bool {
        matches!(self, Phase::Idle | Phase::UpToDate | Phase::Failed)
    }

    /// The tray item's words, and whether it can be clicked.
    fn tray_item(&self) -> (String, bool) {
        match self {
            Phase::Off => ("Updates are off in this build".to_owned(), false),
            Phase::Checking => ("Checking for updates…".to_owned(), false),
            Phase::Downloading { version, .. } => (format!("Getting version {version}…"), false),
            Phase::Ready { version } => (format!("Restart to update to {version}"), true),
            Phase::Idle | Phase::UpToDate | Phase::Failed => ("Check for updates".to_owned(), true),
        }
    }
}

/// How much of a download has arrived, in whole percent, if its size is known.
fn percent(received: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|total| *total > 0)?;
    Some((received.min(total) * 100 / total) as u8)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    current: String,
    phase: Phase,
}

struct Inner {
    phase: Phase,
    /// The verified installer, kept until the student restarts.
    ready: Option<(Update, Vec<u8>)>,
}

struct Updates {
    source: Option<Source>,
    inner: Mutex<Inner>,
}

/// The tray's update item.
pub struct TrayItem(pub MenuItem<Wry>);

/// Who asked: only the tray has nowhere else to show the outcome of a check.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Asked {
    Timer,
    Tray,
    Page,
}

fn lock(updates: &Updates) -> std::sync::MutexGuard<'_, Inner> {
    updates
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Starts the timer, in builds that update themselves.
pub fn start(app: &AppHandle<Wry>) {
    let source = built_in_source(app);
    let on = source.is_some();
    let phase = if on { Phase::Idle } else { Phase::Off };
    app.manage(Updates {
        source,
        inner: Mutex::new(Inner { phase, ready: None }),
    });
    show_phase(app);
    if !on {
        return;
    }
    let handle = app.clone();
    let started = std::thread::Builder::new()
        .name("neb-updates".into())
        .spawn(move || {
            std::thread::sleep(FIRST_CHECK_AFTER);
            loop {
                check(&handle, Asked::Timer);
                std::thread::sleep(CHECK_EVERY);
            }
        });
    if started.is_err() {
        eprintln!("[updates] couldn't start the timer");
    }
}

fn set_phase(app: &AppHandle<Wry>, phase: Phase) {
    if let Some(updates) = app.try_state::<Updates>() {
        lock(&updates).phase = phase;
    }
    show_phase(app);
}

/// Brings the tray item and any open settings page up to date.
fn show_phase(app: &AppHandle<Wry>) {
    let Some(updates) = app.try_state::<Updates>() else {
        return;
    };
    let (words, enabled) = lock(&updates).phase.tray_item();
    if let Some(item) = app.try_state::<TrayItem>() {
        let _ = item.0.set_text(words);
        let _ = item.0.set_enabled(enabled);
    }
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        let _ = window.eval(CHANGED_SCRIPT);
    }
}

fn notify(app: &AppHandle<Wry>, body: &str) {
    let _ = app.notification().builder().title("Neb").body(body).show();
}

/// One check and, if there's a newer version, its download. Blocks; call off the main thread.
fn check(app: &AppHandle<Wry>, asked: Asked) {
    let Some(updates) = app.try_state::<Updates>() else {
        return;
    };
    let source = {
        let mut inner = lock(&updates);
        if !inner.phase.may_check() {
            return;
        }
        inner.phase = Phase::Checking;
        updates.source.clone()
    };
    show_phase(app);
    let Some(source) = source else {
        set_phase(app, Phase::Off);
        return;
    };
    match tauri::async_runtime::block_on(fetch(app, &source)) {
        Ok(Some((update, installer))) => {
            let version = update.version.clone();
            lock(&updates).ready = Some((update, installer));
            notify(
                app,
                &format!(
                    "Version {version} is ready. Restart from the tray icon when it suits you."
                ),
            );
            set_phase(app, Phase::Ready { version });
        }
        Ok(None) => {
            set_phase(app, Phase::UpToDate);
            if asked == Asked::Tray {
                notify(app, "You have the latest version.");
            }
        }
        Err(error) => {
            eprintln!("[updates] {error}");
            set_phase(app, Phase::Failed);
            if asked == Asked::Tray {
                notify(app, "Couldn't check for updates. Try again later.");
            }
        }
    }
}

/// The newer version and its verified installer, if there is one.
async fn fetch(
    app: &AppHandle<Wry>,
    source: &Source,
) -> Result<Option<(Update, Vec<u8>)>, tauri_plugin_updater::Error> {
    let updater = app
        .updater_builder()
        .pubkey(source.pubkey.clone())
        .endpoints(vec![source.manifest.clone()])?
        .timeout(TIMEOUT)
        .build()?;
    let Some(update) = updater.check().await? else {
        return Ok(None);
    };
    let version = update.version.clone();
    set_phase(
        app,
        Phase::Downloading {
            version: version.clone(),
            percent: None,
        },
    );
    let mut received = 0_u64;
    let mut shown = None;
    let installer = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                let now = percent(received, total);
                if now != shown {
                    shown = now;
                    set_phase(
                        app,
                        Phase::Downloading {
                            version: version.clone(),
                            percent: now,
                        },
                    );
                }
            },
            || (),
        )
        .await?;
    Ok(Some((update, installer)))
}

/// Runs the installer, which closes the app and reopens it. Only the student's click gets here.
fn install(app: &AppHandle<Wry>) {
    let Some(updates) = app.try_state::<Updates>() else {
        return;
    };
    let ready = lock(&updates).ready.take();
    let Some((update, installer)) = ready else {
        return;
    };
    if let Err(error) = update.install(installer) {
        eprintln!("[updates] couldn't start the installer ({error})");
        set_phase(app, Phase::Failed);
    }
}

fn in_background(app: &AppHandle<Wry>, job: impl FnOnce(&AppHandle<Wry>) + Send + 'static) {
    let handle = app.clone();
    let started = std::thread::Builder::new()
        .name("neb-update".into())
        .spawn(move || job(&handle));
    if started.is_err() {
        eprintln!("[updates] couldn't start");
    }
}

/// The tray item: restarts with a version that's ready, otherwise checks.
pub fn from_tray(app: &AppHandle<Wry>) {
    let ready = app
        .try_state::<Updates>()
        .is_some_and(|updates| matches!(lock(&updates).phase, Phase::Ready { .. }));
    if ready {
        in_background(app, install);
    } else {
        in_background(app, |app| check(app, Asked::Tray));
    }
}

fn view(app: &AppHandle<Wry>) -> Result<UpdateView, String> {
    let updates = app
        .try_state::<Updates>()
        .ok_or_else(|| "Updates aren't available.".to_owned())?;
    let phase = lock(&updates).phase.clone();
    Ok(UpdateView {
        current: app.package_info().version.to_string(),
        phase,
    })
}

#[tauri::command]
pub fn desktop_update_status(window: WebviewWindow<Wry>) -> Result<UpdateView, String> {
    require_settings_window(&window)?;
    view(window.app_handle())
}

#[tauri::command]
pub fn desktop_update_check(window: WebviewWindow<Wry>) -> Result<UpdateView, String> {
    require_settings_window(&window)?;
    let app = window.app_handle();
    in_background(app, |app| check(app, Asked::Page));
    view(app)
}

#[tauri::command]
pub fn desktop_update_install(window: WebviewWindow<Wry>) -> Result<UpdateView, String> {
    require_settings_window(&window)?;
    let app = window.app_handle();
    in_background(app, install);
    view(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updates_need_a_key_and_an_https_address() {
        let url = Some("https://example.com/desktop/latest.json");
        assert!(source(Some("key"), url).is_some());
        for (key, manifest) in [
            (None, url),
            (Some("key"), None),
            (Some("  "), url),
            (Some("key"), Some("http://example.com/latest.json")),
            (Some("key"), Some("file:///C:/latest.json")),
            (Some("key"), Some("not a url")),
        ] {
            assert_eq!(source(key, manifest), None, "{key:?} {manifest:?}");
        }
    }

    #[test]
    fn a_check_never_interrupts_a_download_or_a_waiting_version() {
        assert!(Phase::Idle.may_check());
        assert!(Phase::UpToDate.may_check());
        assert!(Phase::Failed.may_check());
        assert!(!Phase::Off.may_check());
        assert!(!Phase::Checking.may_check());
        let version = "0.2.0".to_owned();
        assert!(!Phase::Ready {
            version: version.clone()
        }
        .may_check());
        assert!(!Phase::Downloading {
            version,
            percent: None
        }
        .may_check());
    }

    #[test]
    fn the_tray_offers_a_restart_only_when_a_version_is_ready() {
        let (words, enabled) = Phase::Ready {
            version: "0.2.0".to_owned(),
        }
        .tray_item();
        assert_eq!(words, "Restart to update to 0.2.0");
        assert!(enabled);
        assert!(!Phase::Checking.tray_item().1);
        assert!(!Phase::Off.tray_item().1);
        assert_eq!(Phase::Failed.tray_item().0, "Check for updates");
    }

    #[test]
    fn download_progress_stays_a_percentage() {
        assert_eq!(percent(50, Some(200)), Some(25));
        assert_eq!(percent(300, Some(200)), Some(100));
        assert_eq!(percent(50, None), None);
        assert_eq!(percent(50, Some(0)), None);
    }
}
