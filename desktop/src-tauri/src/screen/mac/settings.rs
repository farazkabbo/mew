//! Bundled Mac settings only; the hosted notebook never receives these privileges.
use super::{island, runtime};
use crate::screen::{
    config::{CircleSettings, HelpLevel, Privacy, ScreenConfig},
    cursor::settings::CursorSettings,
    handoff::settings::HandoffSettings,
};
use serde::{Deserialize, Serialize};
use tauri::{
    ipc::CapabilityBuilder, AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
pub const SETTINGS_WINDOW: &str = "mac-screen-settings";
const PAGE: &str = "mac-screen-settings.html";
fn allowed(label: &str, url: &tauri::Url, dev: Option<&tauri::Url>) -> bool {
    label == SETTINGS_WINDOW
        && crate::screen::is_local_page(url, dev)
        && url.path() == format!("/{PAGE}")
}
pub fn require_settings_window(window: &WebviewWindow) -> Result<(), String> {
    let dev = window.app_handle().config().build.dev_url.as_ref();
    if window
        .url()
        .is_ok_and(|url| allowed(window.label(), &url, dev))
    {
        Ok(())
    } else {
        Err("Not allowed.".into())
    }
}
pub fn capability(app: &AppHandle) -> Result<(), String> {
    app.add_capability(
        CapabilityBuilder::new("mac-settings")
            .local(true)
            .window(SETTINGS_WINDOW)
            .permission("allow-mac-settings-status")
            .permission("allow-mac-settings-update")
            .permission("allow-mac-tools-toggle")
            .permission("allow-mac-handoff-start")
            .permission("allow-mac-handoff-forget")
            .permission("allow-mac-open-microphone-settings")
            .permission("allow-mac-open-notebook")
            .permission("allow-mac-local-history")
            .permission("allow-screen-coach-forget-paths")
            .permission("allow-desktop-update-status")
            .permission("allow-desktop-update-check")
            .permission("allow-desktop-update-install"),
    )
    .map_err(|_| "Couldn't configure Mac settings.".into())
}
pub fn open(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        window
            .show()
            .and_then(|_| window.set_focus())
            .map_err(|_| "Couldn't open Mac settings.".into())
    } else {
        let dev = app.config().build.dev_url.clone();
        WebviewWindowBuilder::new(app, SETTINGS_WINDOW, WebviewUrl::App(PAGE.into()))
            .title("Neb — Screen Coach settings")
            .inner_size(720., 760.)
            .min_inner_size(480., 500.)
            .on_navigation(move |url| {
                crate::screen::is_local_page(url, dev.as_ref()) && url.path() == format!("/{PAGE}")
            })
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .build()
            .map(|_| ())
            .map_err(|_| "Couldn't open Mac settings.".into())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    config: ScreenConfig,
    settings_reset: bool,
    default_privacy: Privacy,
    handoff_timeline: Option<serde_json::Value>,
    catch_paused: bool,
    account_connected: Option<bool>,
    island_visible: bool,
    cursor_counts: Option<crate::screen::cursor::telemetry::Counts>,
    voice_shortcut_available: bool,
    tools_shortcut_available: bool,
    capture_available: bool,
    capture_blocker: &'static str,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Patch {
    enabled: Option<bool>,
    consent_version: Option<u32>,
    paused: Option<bool>,
    privacy: Option<Privacy>,
    circle: Option<CircleSettings>,
    help: Option<HelpLevel>,
    cursor: Option<CursorSettings>,
    handoff: Option<HandoffSettings>,
}
fn edit(config: &mut ScreenConfig, patch: Patch) -> Result<(), String> {
    let mut next = config.clone();
    edit_inner(&mut next, patch)?;
    *config = next;
    Ok(())
}
fn edit_inner(config: &mut ScreenConfig, patch: Patch) -> Result<(), String> {
    if let Some(enabled) = patch.enabled {
        if enabled && patch.consent_version != Some(crate::screen::config::CONSENT_VERSION) {
            return Err("Read and accept the current Screen Coach privacy notice first.".into());
        }
        config.enabled = enabled;
        config.consent_version = if enabled {
            crate::screen::config::CONSENT_VERSION
        } else {
            0
        };
    }
    if let Some(v) = patch.paused {
        config.paused = v;
    }
    if let Some(v) = patch.privacy {
        config.privacy = v.normalized()?;
    }
    if let Some(v) = patch.circle {
        config.circle = v;
    }
    if let Some(v) = patch.help {
        config.help = v;
    }
    if patch.cursor.as_ref().is_some_and(|c| {
        c.catch_me && c.catch_me_consent != crate::screen::cursor::settings::CATCH_ME_CONSENT
    }) {
        return Err("Read the CATCH ME privacy notice before enabling it.".into());
    }
    if let Some(v) = patch.cursor {
        config.cursor = v.normalized()?;
    }
    if let Some(v) = patch.handoff {
        config.handoff = v.normalized();
    }
    Ok(())
}
fn status(app: &AppHandle) -> Result<Status, String> {
    let (config, settings_reset) = runtime::of(app)?.snapshot();
    Ok(Status {
        config,
        settings_reset,
        default_privacy: Privacy::default(),
        handoff_timeline: None,
        catch_paused: runtime::catch_paused(app),
        account_connected: app.try_state::<crate::screen::sign_in::SignIn>().and_then(|s|s.known_connected()),
        island_visible: island::shown(app),
        cursor_counts:None,
        voice_shortcut_available:crate::mac_shortcut::voice_registered(app),
        tools_shortcut_available:crate::mac_shortcut::tools_registered(app),
        capture_available: true,
        capture_blocker: "Screen Coach captures a privacy-checked supported window. Display capture blacks out other windows. Chrome and Brave require a verified normal window and existing Automation permission. Safari, Firefox and unknown browser states are refused. Grant macOS Screen Recording and Accessibility permissions before testing.",
    })
}
#[tauri::command]
pub fn mac_settings_status(window: WebviewWindow) -> Result<Status, String> {
    require_settings_window(&window)?;
    status(window.app_handle())
}
#[tauri::command]
pub fn mac_settings_update(window: WebviewWindow, patch: Patch) -> Result<Status, String> {
    require_settings_window(&window)?;
    let app = window.app_handle();
    let before = runtime::of(app)?.snapshot().0;
    runtime::of(app)?.update(|config| edit(config, patch))?;
    if before.handoff.timeline && !runtime::of(app)?.snapshot().0.handoff.timeline {
        super::handoff_runtime::forget_timeline(app);
    }
    runtime::apply(app)?;
    status(app)
}
#[tauri::command]
pub fn mac_tools_toggle(window: WebviewWindow) -> Result<Status, String> {
    require_settings_window(&window)?;
    runtime::toggle_island(window.app_handle())?;
    status(window.app_handle())
}
#[tauri::command]
pub fn screen_coach_onboarding(window: WebviewWindow, open_settings: bool) -> Result<bool, String> {
    let app = window.app_handle();
    let sign_in = app
        .try_state::<crate::screen::sign_in::SignIn>()
        .ok_or("Account services aren't ready.")?;
    crate::screen::page::require_app_page(&window, sign_in.app_url())?;
    if open_settings {
        open(app)?;
    }
    let (config, _) = runtime::of(app)?.snapshot();
    Ok(config.is_on() && !config.paused)
}
#[tauri::command]
pub async fn mac_local_history(window: WebviewWindow) -> Result<Status, String> {
    require_settings_window(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let counts = super::counts::view(&app);
        let timeline = super::handoff_runtime::debug_view(&app);
        let mut view = status(&app)?;
        view.cursor_counts = Some(counts);
        view.handoff_timeline = Some(timeline);
        Ok(view)
    })
    .await
    .map_err(|_| "Couldn't inspect local history.")?
}
#[tauri::command]
pub fn mac_open_notebook(window: WebviewWindow) -> Result<(), String> {
    require_settings_window(&window)?;
    crate::show(window.app_handle())
        .map(|_| ())
        .ok_or_else(|| "Couldn't open your notebook.".into())
}
#[tauri::command]
pub async fn mac_handoff_forget(window: WebviewWindow) -> Result<Status, String> {
    require_settings_window(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        super::handoff_runtime::forget_timeline(&app);
        status(&app)
    })
    .await
    .map_err(|_| "Couldn't delete Handoff timeline.")?
}
#[tauri::command]
pub async fn mac_open_microphone_settings(window: WebviewWindow) -> Result<(), String> {
    require_settings_window(&window)?;
    // A fixed OS preference pane only; no web/model argument can select a URI or app.
    tauri::async_runtime::spawn_blocking(|| {
        std::process::Command::new("/usr/bin/open")
            .arg("--")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .status()
            .map_err(|_| "Couldn't open microphone settings.")?
            .success()
            .then_some(())
            .ok_or_else(|| "Couldn't open microphone settings.".to_owned())
    })
    .await
    .map_err(|_| "Couldn't open microphone settings.")?
}

#[tauri::command]
pub async fn mac_handoff_start(window: WebviewWindow) -> Result<(), String> {
    require_settings_window(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || super::handoff_runtime::start(&app, None))
        .await
        .map_err(|_| "Handoff stopped.")?
}

#[tauri::command]
pub async fn screen_coach_forget_paths(window: WebviewWindow) -> Result<(), String> {
    require_settings_window(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || super::cursor_runtime::forget_paths(&app))
        .await
        .map_err(|_| "Couldn't forget learned paths.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn caller_needs_exact_local_window_and_page() {
        let url = |u| tauri::Url::parse(u).unwrap();
        assert!(allowed(
            SETTINGS_WINDOW,
            &url("tauri://localhost/mac-screen-settings.html"),
            None
        ));
        assert!(!allowed(
            "main",
            &url("tauri://localhost/mac-screen-settings.html"),
            None
        ));
        assert!(!allowed(
            SETTINGS_WINDOW,
            &url("https://example.com/mac-screen-settings.html"),
            None
        ));
        assert!(!allowed(
            SETTINGS_WINDOW,
            &url("tauri://localhost/island.html"),
            None
        ));
    }
    #[test]
    fn capture_requires_current_explicit_consent_and_failed_patch_is_atomic() {
        let mut c = ScreenConfig::default();
        let before = c.clone();
        assert!(edit(
            &mut c,
            Patch {
                enabled: Some(true),
                consent_version: Some(0),
                ..Default::default()
            }
        )
        .is_err());
        assert_eq!(c, before);
        edit(
            &mut c,
            Patch {
                enabled: Some(true),
                consent_version: Some(crate::screen::config::CONSENT_VERSION),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(c.is_on());
        edit(
            &mut c,
            Patch {
                enabled: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!c.is_on());
    }
    #[test]
    fn patch_preserves_other_preferences_and_refuses_unavailable_services() {
        let mut c = ScreenConfig::default();
        c.handoff.sender_name = "Student".into();
        edit(
            &mut c,
            Patch {
                help: Some(HelpLevel::Coach),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(c.handoff.sender_name, "Student");
        assert_eq!(c.help, HelpLevel::Coach);
        let before = c.clone();
        let cursor = CursorSettings {
            catch_me: true,
            catch_me_consent: 0,
            ..Default::default()
        };
        assert!(edit(
            &mut c,
            Patch {
                cursor: Some(cursor),
                paused: Some(true),
                ..Default::default()
            }
        )
        .is_err());
        assert_eq!(c, before);
    }
}
