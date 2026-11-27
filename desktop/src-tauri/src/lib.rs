//! Neb's desktop window and native reminders. Windows also includes a system-wide summon
//! gesture and Screen Coach (docs/SCREEN_COACH.md).
//!
//! Security: the window shows a remote origin (the web app). That origin may call three
//! commands, each checked in Rust: `notify_due`, and Screen Coach's `screen_coach_ask` (the
//! words of a question; never pixels), `screen_coach_spoken` (a spoken line ended: Circle & Ask's
//! timing) and `screen_coach_link_finish` (a one-time sign-in code), plus the browser sign-in's
//! `desktop_sign_in_start`, `desktop_sign_in_ticket` and `desktop_sign_out`.
//! Everything else (the hold gesture, tray, windows, screen capture) happens in Rust. Screen Coach's
//! settings commands are granted to its bundled local page only, and its overlay commands to
//! its overlay pages only (each window its own). Links the web page opens in a new window go to
//! the default browser (https only), never into a window of ours.

#[cfg(target_os = "macos")]
mod mac_shortcut;
mod origin;
mod reminders;
pub mod screen;
#[cfg(any(windows, target_os = "macos"))]
mod updates;

use tauri::{
    ipc::CapabilityBuilder,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
#[cfg(not(target_os = "macos"))]
use tauri::{
    menu::{CheckMenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
};

use reminders::Reminders;

pub(crate) const MAIN: &str = "main";
pub const TRAY_ID: &str = "mew";
/// WebView2 arguments, the same for every window (windows sharing a profile must agree): wry's
/// defaults, plus letting Screen Coach's answers play aloud without a click on the page (the
/// question was asked with a hotkey, which the page doesn't see as a gesture).
#[cfg(windows)]
pub(crate) const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";
/// Tells the page to summon Mew (it listens for this event; see the web app's desktop bridge).
const SUMMON_SCRIPT: &str = "window.dispatchEvent(new CustomEvent('mew:summon'))";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_url = origin::app_url(std::env::var("MEW_APP_URL").ok());
    let builder = tauri::Builder::default();
    // First, as its docs require: a second launch (a neb:// link opening, say) hands over to the
    // running app and exits.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        show(app);
    }));
    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        // Its commands are granted to no page: `updates.rs` drives it from Rust.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Reminders::default())
        .invoke_handler(handlers());
    #[cfg(any(windows, target_os = "macos"))]
    let builder = builder.manage(screen::sign_in::SignIn::new(app_url.clone()));
    // A clip's preview image, served from memory to the preview window only (S3).
    #[cfg(windows)]
    let builder = builder.register_uri_scheme_protocol(screen::clip::SCHEME, screen::clip::serve);
    #[cfg(target_os = "macos")]
    let builder =
        builder.register_uri_scheme_protocol(screen::mac::clip::SCHEME, screen::mac::clip::serve);
    #[cfg(target_os = "macos")]
    let builder = builder.register_uri_scheme_protocol(
        screen::mac::handoff_runtime::SCHEME,
        screen::mac::handoff_runtime::serve,
    );
    // A handoff draft's crops, served from memory to the preview window only.
    #[cfg(windows)]
    let builder = builder
        .register_uri_scheme_protocol(screen::handoff_run::SCHEME, screen::handoff_run::serve);
    let app = builder
        .setup(move |app| {
            remote_capability(app.handle(), &app_url)?;
            let window = main_window(app.handle(), app_url.clone())?;
            #[cfg(target_os = "macos")]
            {
                screen::mac::runtime::setup(app.handle()).map_err(std::io::Error::other)?;
                mac_shortcut::setup(app.handle(), app_url.clone());
            }
            tray(app.handle())?;
            #[cfg(all(desktop, not(target_os = "macos")))]
            hotkeys(app.handle())?;
            #[cfg(windows)]
            screen::coach::setup(app.handle(), app_url.clone())?;
            // The hold gesture summons Neb (or, with Screen Coach on, circles and talks): K2.
            #[cfg(windows)]
            screen::keys::start(app.handle());
            #[cfg(any(windows, target_os = "macos"))]
            updates::start(app.handle());
            #[cfg(any(windows, target_os = "macos"))]
            sign_in_links(app.handle())?;
            let _ = window.set_focus();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Mew");
    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            show(app);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}

/// The website's way back to the app after a browser sign-in. A link that launched the app is
/// ignored on purpose: that process can't have started the sign-in it answers.
#[cfg(any(windows, target_os = "macos"))]
fn sign_in_links(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_deep_link::DeepLinkExt;
    // An installed app is registered by its installer; a development build registers itself.
    #[cfg(all(windows, debug_assertions))]
    app.deep_link().register_all()?;
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for link in event.urls() {
            // neb://handoff/<uuid> (strictly): the handoff opens in the main window.
            #[cfg(windows)]
            if let Some(id) = screen::handoff_run::parse_link(&link) {
                screen::handoff_run::open_link(&handle, &id);
                continue;
            }
            #[cfg(target_os = "macos")]
            if let Some(id) = screen::mac::handoff_runtime::parse_link(&link) {
                screen::mac::handoff_runtime::open_link(&handle, &id);
                continue;
            }
            screen::sign_in::on_link(&handle, &link);
        }
    });
    Ok(())
}

#[cfg(windows)]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    use screen::account::{
        screen_coach_disconnect, screen_coach_link_finish, screen_coach_link_start,
    };
    use screen::annotate::{screen_ink_drawn, screen_ink_pill};
    use screen::ask::screen_coach_ask;
    use screen::circle::{
        screen_circle_card, screen_draw_erase, screen_draw_island_press, screen_draw_mark,
        screen_draw_note, screen_draw_pen, screen_draw_select,
    };
    use screen::circle_answer::screen_coach_spoken;
    use screen::clip::{screen_clip_cancel, screen_clip_ready, screen_clip_save};
    use screen::coach::{
        screen_coach_forget_paths, screen_coach_handoff, screen_coach_onboarding,
        screen_coach_open_mic_settings, screen_coach_set_circle, screen_coach_set_cursor,
        screen_coach_set_enabled, screen_coach_set_paused, screen_coach_set_privacy,
        screen_coach_shortcuts_seen, screen_coach_status,
    };
    use screen::coach_mode::screen_coach_pill;
    use screen::handoff_run::{
        handoff_pick_up, handoff_preview_blur, handoff_preview_cancel, handoff_preview_copy,
        handoff_preview_send, handoff_preview_state, handoff_preview_update,
    };
    use screen::notes_check::screen_notes_panel;
    use screen::screen_island::screen_island;
    use screen::screen_quiz::screen_quiz_card;
    use screen::sign_in::{
        desktop_sign_in_cancel, desktop_sign_in_start, desktop_sign_in_ticket, desktop_sign_out,
    };
    use updates::{desktop_update_check, desktop_update_install, desktop_update_status};
    tauri::generate_handler![
        desktop_sign_in_start,
        desktop_sign_in_cancel,
        desktop_sign_in_ticket,
        desktop_sign_out,
        reminders::notify_due,
        reminders::notify_checks,
        reminders::notify_skills,
        screen_coach_onboarding,
        screen_coach_status,
        screen_coach_set_enabled,
        screen_coach_set_paused,
        screen_coach_shortcuts_seen,
        screen_coach_set_privacy,
        screen_coach_open_mic_settings,
        screen_coach_link_start,
        screen_coach_link_finish,
        screen_coach_disconnect,
        screen_coach_ask,
        screen_ink_drawn,
        screen_ink_pill,
        screen_clip_ready,
        screen_clip_save,
        screen_clip_cancel,
        screen_notes_panel,
        screen_coach_pill,
        screen_coach_set_circle,
        screen_coach_set_cursor,
        screen_coach_forget_paths,
        screen_coach_spoken,
        screen_coach_handoff,
        handoff_preview_state,
        handoff_preview_update,
        handoff_preview_blur,
        handoff_preview_send,
        handoff_preview_copy,
        handoff_preview_cancel,
        handoff_pick_up,
        screen_draw_mark,
        screen_draw_erase,
        screen_draw_island_press,
        screen_draw_pen,
        screen_draw_select,
        screen_draw_note,
        screen_circle_card,
        screen_quiz_card,
        screen_island,
        desktop_update_status,
        desktop_update_check,
        desktop_update_install
    ]
}

#[cfg(target_os = "macos")]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    use screen::sign_in::{
        desktop_sign_in_cancel, desktop_sign_in_start, desktop_sign_in_ticket, desktop_sign_out,
    };

    use screen::mac::{
        annotate::{screen_ink_drawn, screen_ink_pill, screen_ink_ready},
        ask::{screen_coach_ask, screen_coach_spoken},
        circle::{screen_circle_card, screen_circle_ready},
        clip::{screen_clip_cancel, screen_clip_ready, screen_clip_save},
        cursor_runtime::mac_cursor_catch_action,
        drawing::{
            screen_draw_erase, screen_draw_island_press, screen_draw_mark, screen_draw_note,
            screen_draw_pen, screen_draw_ready, screen_draw_select,
        },
        handoff_runtime::{
            handoff_pick_up, handoff_preview_blur, handoff_preview_cancel, handoff_preview_copy,
            handoff_preview_send, handoff_preview_state, handoff_preview_update,
        },
        island::screen_island,
        settings::{
            mac_handoff_forget, mac_handoff_start, mac_local_history, mac_open_microphone_settings,
            mac_open_notebook, mac_settings_status, mac_settings_update, mac_tools_toggle,
            screen_coach_forget_paths, screen_coach_onboarding,
        },
        study::{screen_coach_pill, screen_notes_panel, screen_quiz_card},
    };
    use updates::{desktop_update_check, desktop_update_install, desktop_update_status};
    tauri::generate_handler![
        screen_coach_ask,
        screen_notes_panel,
        screen_coach_pill,
        screen_quiz_card,
        screen_ink_ready,
        screen_ink_drawn,
        screen_ink_pill,
        screen_coach_onboarding,
        screen_clip_ready,
        screen_clip_save,
        screen_clip_cancel,
        screen_circle_card,
        screen_coach_spoken,
        screen_circle_ready,
        mac_cursor_catch_action,
        handoff_preview_state,
        handoff_preview_update,
        handoff_preview_blur,
        handoff_preview_send,
        handoff_preview_copy,
        handoff_preview_cancel,
        handoff_pick_up,
        screen_coach_forget_paths,
        mac_handoff_start,
        mac_handoff_forget,
        mac_open_microphone_settings,
        mac_open_notebook,
        mac_local_history,
        mac_settings_status,
        mac_settings_update,
        mac_tools_toggle,
        screen_draw_ready,
        screen_draw_note,
        screen_draw_pen,
        screen_draw_erase,
        screen_draw_mark,
        screen_draw_select,
        screen_draw_island_press,
        screen_island,
        desktop_update_status,
        desktop_update_check,
        desktop_update_install,
        mac_shortcut::desktop_summon_shortcut,
        desktop_sign_in_start,
        desktop_sign_in_cancel,
        desktop_sign_in_ticket,
        desktop_sign_out,
        reminders::notify_due,
        reminders::notify_checks,
        reminders::notify_skills
    ]
}

#[cfg(not(any(windows, target_os = "macos")))]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        reminders::notify_due,
        reminders::notify_checks,
        reminders::notify_skills
    ]
}

/// The web app's pages (and only they) may call these: review reminders, and Screen Coach's
/// two page-facing commands (each also re-checks the calling window in Rust).
fn remote_capability(app: &AppHandle, app_url: &Url) -> tauri::Result<()> {
    let capability = CapabilityBuilder::new("mew-web-app")
        .remote(origin::capability_pattern(app_url))
        .local(false)
        .window(MAIN)
        .permission("allow-notify-due")
        .permission("allow-notify-checks")
        .permission("allow-notify-skills");
    #[cfg(any(windows, target_os = "macos"))]
    let capability = capability
        .permission("allow-desktop-sign-in-start")
        .permission("allow-desktop-sign-in-cancel")
        .permission("allow-desktop-sign-in-ticket")
        .permission("allow-desktop-sign-out");
    #[cfg(target_os = "macos")]
    let capability = capability
        .permission("allow-desktop-summon-shortcut")
        .permission("allow-handoff-pick-up")
        .permission("allow-screen-coach-spoken")
        .permission("allow-screen-coach-onboarding")
        .permission("allow-screen-coach-ask");
    #[cfg(windows)]
    let capability = capability
        .permission("allow-screen-coach-ask")
        .permission("allow-screen-coach-onboarding")
        .permission("allow-screen-coach-spoken")
        .permission("allow-screen-coach-link-finish")
        .permission("allow-handoff-pick-up");
    app.add_capability(capability)
}

fn main_window(app: &AppHandle, app_url: Url) -> tauri::Result<WebviewWindow> {
    let allowed = app_url.clone();
    #[cfg(target_os = "macos")]
    let microphone_origin = allowed.origin();
    let start = app_url.join("desk").unwrap_or(app_url);
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(start))
        .title("Neb")
        .inner_size(1280.0, 840.0)
        .min_inner_size(900.0, 600.0);
    #[cfg(windows)]
    let builder = builder.additional_browser_args(BROWSER_ARGS);
    #[cfg(target_os = "macos")]
    let builder = builder.with_webview_configuration(mac_webview_configuration()?);
    #[cfg(target_os = "macos")]
    let builder = builder.on_permission_request(move |webview, kind| {
        use tauri::webview::{PermissionKind, PermissionResponse};

        if matches!(kind, PermissionKind::Microphone)
            && webview
                .url()
                .is_ok_and(|url| url.origin() == microphone_origin)
        {
            PermissionResponse::Default
        } else {
            PermissionResponse::Deny
        }
    });
    let window = builder
        .on_navigation(move |target| origin::may_navigate(&allowed, target))
        // A link opened in a new window (a saved clip's source, say) goes to the default
        // browser, https only; no window of ours ever shows another site.
        .on_new_window(|url, _features| {
            #[cfg(windows)]
            screen::win::system::open_in_browser(&url);
            #[cfg(target_os = "macos")]
            if origin::may_open_external_link(&url) {
                tauri::async_runtime::spawn_blocking(move || origin::open_in_mac_browser(&url));
            }
            #[cfg(not(any(windows, target_os = "macos")))]
            let _ = url;
            tauri::webview::NewWindowResponse::Deny
        })
        .build()?;
    // Closing the window keeps Mew in the tray, so the hotkeys and reminders keep working.
    let hidden = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hidden.hide();
        }
    });
    Ok(window)
}

#[cfg(target_os = "macos")]
fn mac_webview_configuration(
) -> tauri::Result<objc2::rc::Retained<objc2_web_kit::WKWebViewConfiguration>> {
    let main_thread = objc2::MainThreadMarker::new()
        .ok_or_else(|| std::io::Error::other("Neb's WKWebView must start on the main thread"))?;
    // SAFETY: the configuration and its preferences are created and used on the main thread.
    let configuration = unsafe {
        let configuration = objc2_web_kit::WKWebViewConfiguration::new(main_thread);
        configuration
            .preferences()
            .setJavaScriptCanOpenWindowsAutomatically(false);
        configuration
    };
    Ok(configuration)
}

/// Brings the window back (from the tray, minimised or behind other apps).
pub(crate) fn show<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    let window = app.get_webview_window(MAIN)?;
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    Some(window)
}

/// Opens Neb at a line of the student's own notebook (docs/PLAN.md, "teach from your notes"):
/// asked to do the work, neb shows where they wrote about it instead. The page (an id) and the
/// line's box were checked when the event was parsed; they reach the page as JSON.
#[cfg(any(windows, target_os = "macos"))]
pub(crate) fn open_note<R: tauri::Runtime>(app: &AppHandle<R>, spot: &screen::protocol::NoteSpot) {
    let detail = serde_json::json!({ "pageId": spot.page_id, "bbox": spot.bbox });
    if let Some(window) = show(app) {
        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent('mew:open-note', {{ detail: {detail} }}))"
        ));
    }
}

/// Shows the window and asks Mew to listen, as if the mascot was tapped (the hold gesture while
/// Screen Coach is off, or "Ask Neb" in the tray).
pub(crate) fn summon<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(window) = show(app) {
        let _ = window.eval(SUMMON_SCRIPT);
    }
}

#[cfg(not(target_os = "macos"))]
fn tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Neb", true, None::<&str>)?;
    let ask = MenuItem::with_id(
        app,
        "summon",
        "Ask Neb  (hold Ctrl+Alt)",
        true,
        None::<&str>,
    )?;
    // Screen Coach: enabled and checked by `screen::coach::refresh` as its state changes.
    let look = MenuItem::with_id(app, "screen-look", "Look at my screen", false, None::<&str>)?;
    let pause = CheckMenuItem::with_id(
        app,
        "screen-pause",
        "Pause Screen Coach",
        false,
        false,
        None::<&str>,
    )?;
    // NEB_APP_UI §5.4 (U7): a pause that ends by itself.
    let pause_hour = MenuItem::with_id(
        app,
        "screen-pause-hour",
        "Pause for 1 hour",
        false,
        None::<&str>,
    )?;
    let stop_walkthrough = MenuItem::with_id(
        app,
        "screen-coach-stop",
        "Stop the walkthrough",
        false,
        None::<&str>,
    )?;
    // The cursor modes (docs/CURSOR_MODES.md): CATCH ME's one-click pause, and DO IT's undo.
    let catch_pause = CheckMenuItem::with_id(
        app,
        "cursor-catch-pause",
        "Pause CATCH ME",
        false,
        false,
        None::<&str>,
    )?;
    let hand_off = MenuItem::with_id(
        app,
        "handoff-start",
        "Hand off… (being built)",
        cfg!(windows),
        None::<&str>,
    )?;
    let undo_rename = MenuItem::with_id(
        app,
        "cursor-undo-rename",
        "Undo rename",
        cfg!(windows),
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(
        app,
        "screen-settings",
        "Screen Coach settings…",
        true,
        None::<&str>,
    )?;
    // Says "Restart to update to …" once a new version is ready (`updates.rs`).
    let update = MenuItem::with_id(
        app,
        "update",
        "Check for updates",
        cfg!(windows),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &ask,
            &separator,
            &look,
            &pause,
            &pause_hour,
            &stop_walkthrough,
            &catch_pause,
            &undo_rename,
            &hand_off,
            &settings,
            &separator2,
            &update,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Neb")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                show(app);
            }
            "summon" => summon(app),
            #[cfg(windows)]
            "screen-look" => screen::coach::look_from_tray(app),
            #[cfg(windows)]
            "screen-pause" => screen::coach::toggle_pause(app),
            #[cfg(windows)]
            "screen-pause-hour" => screen::coach::pause_for_an_hour(app),
            #[cfg(windows)]
            "screen-coach-stop" => screen::coach_mode::stop_from_tray(app),
            #[cfg(windows)]
            "cursor-catch-pause" => screen::cursor_run::toggle_catch_pause(app),
            #[cfg(windows)]
            "cursor-undo-rename" => screen::cursor_do::undo_rename(app),
            #[cfg(windows)]
            "handoff-start" => screen::handoff_run::start(app, None),
            #[cfg(windows)]
            "screen-settings" => screen::coach::open_settings(app),
            #[cfg(windows)]
            "update" => updates::from_tray(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    #[cfg(windows)]
    app.manage(screen::coach::TrayItems {
        look,
        pause,
        pause_hour,
        stop_walkthrough,
        catch_pause,
    });
    #[cfg(windows)]
    app.manage(updates::TrayItem(update));
    Ok(())
}

#[cfg(target_os = "macos")]
fn tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Neb", true, None::<&str>)?;
    let label = if mac_shortcut::registered(app) {
        "Ask Neb  (⌃⇧N)"
    } else {
        "Ask Neb  (shortcut unavailable)"
    };
    let ask = MenuItem::with_id(app, "summon", label, true, None::<&str>)?;
    let tools = MenuItem::with_id(
        app,
        "mac-tools",
        "Show or hide Neb tools",
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(
        app,
        "mac-settings",
        "Screen Coach settings…",
        true,
        None::<&str>,
    )?;
    let update = MenuItem::with_id(app, "update", "Check for updates", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Neb", true, None::<&str>)?;
    let look = MenuItem::with_id(
        app,
        "mac-look",
        "Ask about my screen (hold ⌃⇧Space)",
        true,
        None::<&str>,
    )?;
    let pause = MenuItem::with_id(
        app,
        "mac-pause",
        "Pause or resume Screen Coach",
        true,
        None::<&str>,
    )?;
    let watch = MenuItem::with_id(app, "mac-watch", "Start or stop Watch", true, None::<&str>)?;
    let stop = MenuItem::with_id(
        app,
        "mac-stop",
        "Stop all screen tasks (Escape)",
        true,
        None::<&str>,
    )?;
    let pause_hour = MenuItem::with_id(
        app,
        "mac-pause-hour",
        "Pause for 1 hour",
        true,
        None::<&str>,
    )?;
    let catch_pause = MenuItem::with_id(
        app,
        "mac-catch-pause",
        "Pause or resume CATCH ME",
        true,
        None::<&str>,
    )?;
    let undo = MenuItem::with_id(app, "mac-undo-rename", "Undo rename", true, None::<&str>)?;
    let handoff = MenuItem::with_id(app, "mac-handoff", "Prepare a Handoff…", true, None::<&str>)?;
    let keyboard = MenuItem::with_id(
        app,
        "mac-keyboard-select",
        "Select with keyboard",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &ask,
            &look,
            &tools,
            &keyboard,
            &pause,
            &pause_hour,
            &catch_pause,
            &watch,
            &stop,
            &undo,
            &handoff,
            &settings,
            &update,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Neb")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                show(app);
            }
            "summon" => summon(app),
            "mac-look" => {
                if screen::mac::ask::toggle_mic(app).is_err() {
                    let _ = screen::mac::settings::open(app);
                }
            }
            "mac-pause" => {
                if let Ok(r) = screen::mac::runtime::of(app) {
                    let paused = r.snapshot().0.paused;
                    let _ = screen::mac::runtime::set_paused(app, !paused);
                }
            }
            "mac-pause-hour" => {
                let _ = screen::mac::runtime::pause_for_an_hour(app);
            }
            "mac-catch-pause" => {
                let _ = screen::mac::runtime::toggle_catch_pause(app);
            }
            "mac-undo-rename" => {
                let _ = screen::mac::chores::route_words(app, "undo rename");
            }
            "mac-handoff" => {
                let handle = app.clone();
                std::thread::spawn(move || {
                    let _ = screen::mac::handoff_runtime::start(&handle, None);
                });
            }
            "mac-keyboard-select" => {
                let _ = screen::mac::drawing::toggle_keyboard(app);
            }
            "mac-watch" => {
                if screen::mac::study::toggle_watch(app).is_err() {
                    let _ = screen::mac::settings::open(app);
                }
            }
            "mac-stop" => screen::mac::runtime::cancel(app),
            "mac-tools" => {
                let _ = screen::mac::runtime::toggle_island(app);
            }
            "mac-settings" => {
                let _ = screen::mac::settings::open(app);
            }
            "update" => updates::from_tray(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    app.manage(updates::TrayItem(update));
    Ok(())
}

/// Global hotkeys: none of Mew's own (K2: two keys at most, and the summon gesture is polled, in
/// `screen::keys`). Screen Coach registers Esc while it shows something.
#[cfg(all(desktop, not(target_os = "macos")))]
fn hotkeys(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                #[cfg(windows)]
                screen::coach::on_shortcut(app, shortcut, event.state());
                #[cfg(not(windows))]
                let _ = (app, shortcut, event);
            })
            .build(),
    )?;
    Ok(())
}
