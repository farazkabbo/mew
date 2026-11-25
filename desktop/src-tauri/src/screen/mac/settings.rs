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
    island_visible: bool,
    capture_available: bool,
    capture_blocker: &'static str,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Patch {
    paused: Option<bool>,
    privacy: Option<Privacy>,
    circle: Option<CircleSettings>,
    help: Option<HelpLevel>,
    cursor: Option<CursorSettings>,
    handoff: Option<HandoffSettings>,
}
fn edit(config: &mut ScreenConfig, patch: Patch) -> Result<(), String> {
    if patch.privacy.as_ref().is_some_and(|p| p.let_neb_click)
        || patch
            .cursor
            .as_ref()
            .is_some_and(|c| c.catch_me || c.record_traces || c.debug)
        || patch.handoff.as_ref().is_some_and(|h| h.timeline)
    {
        return Err("This Mac service is not connected; it cannot be enabled yet.".into());
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
        island_visible: island::shown(app),
        capture_available: false,
        capture_blocker: runtime::CAPTURE_BLOCKER,
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
    runtime::of(app)?.update(|config| edit(config, patch))?;
    runtime::apply(app)?;
    status(app)
}
#[tauri::command]
pub fn mac_tools_toggle(window: WebviewWindow) -> Result<Status, String> {
    require_settings_window(&window)?;
    runtime::toggle_island(window.app_handle())?;
    status(window.app_handle())
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
        let p = Privacy {
            let_neb_click: true,
            ..Default::default()
        };
        assert!(edit(
            &mut c,
            Patch {
                privacy: Some(p),
                paused: Some(true),
                ..Default::default()
            }
        )
        .is_err());
        assert_eq!(c, before);
    }
}
