//! Mew for Windows: a window onto the Mew web app, plus what a web page can't do on its own:
//! a global hotkey to summon Mew from any app, a tray icon, review reminders, and Screen Coach
//! (docs/SCREEN_COACH.md).
//!
//! Security: the window shows a remote origin (the web app). That origin may call three
//! commands, each checked in Rust: `notify_due`, and Screen Coach's `screen_coach_ask` (the
//! words of a question; never pixels), `screen_coach_spoken` (a spoken line ended: Circle & Ask's
//! timing) and `screen_coach_link_finish` (a one-time sign-in code).
//! Everything else (hotkeys, tray, windows, screen capture) happens in Rust. Screen Coach's
//! settings commands are granted to its bundled local page only, and its overlay commands to
//! its overlay pages only (each window its own). Links the web page opens in a new window go to
//! the default browser (https only), never into a window of ours.

mod origin;
mod reminders;
pub mod screen;

use tauri::{
    ipc::CapabilityBuilder,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

use reminders::Reminders;

pub(crate) const MAIN: &str = "main";
pub const TRAY_ID: &str = "mew";
/// WebView2 arguments, the same for every window (windows sharing a profile must agree): wry's
/// defaults, plus letting Screen Coach's answers play aloud without a click on the page (the
/// question was asked with a hotkey, which the page doesn't see as a gesture).
pub(crate) const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";
/// Tells the page to summon Mew (it listens for this event; see the web app's desktop bridge).
const SUMMON_SCRIPT: &str = "window.dispatchEvent(new CustomEvent('mew:summon'))";

/// Ctrl+Shift+M from any app: Mew comes forward and listens.
fn summon_hotkey() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyM)
}

pub fn is_summon_hotkey(shortcut: &Shortcut) -> bool {
    shortcut == &summon_hotkey()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_url = origin::app_url(std::env::var("MEW_APP_URL").ok());
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(Reminders::default())
        .invoke_handler(handlers());
    // A clip's preview image, served from memory to the preview window only (S3).
    #[cfg(windows)]
    let builder = builder.register_uri_scheme_protocol(screen::clip::SCHEME, screen::clip::serve);
    builder
        .setup(move |app| {
            remote_capability(app.handle(), &app_url)?;
            let window = main_window(app.handle(), app_url.clone())?;
            tray(app.handle())?;
            #[cfg(desktop)]
            hotkeys(app.handle())?;
            #[cfg(windows)]
            screen::coach::setup(app.handle(), app_url.clone())?;
            let _ = window.set_focus();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Mew");
}

#[cfg(windows)]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    use screen::account::{
        screen_coach_disconnect, screen_coach_link_finish, screen_coach_link_start,
    };
    use screen::annotate::{screen_ink_drawn, screen_ink_pill};
    use screen::ask::screen_coach_ask;
    use screen::circle::{
        screen_circle_card, screen_draw_erase, screen_draw_mark, screen_draw_select,
    };
    use screen::circle_answer::screen_coach_spoken;
    use screen::clip::{screen_clip_cancel, screen_clip_ready, screen_clip_save};
    use screen::coach::{
        screen_coach_open_mic_settings, screen_coach_set_circle, screen_coach_set_enabled,
        screen_coach_set_hotkey, screen_coach_set_paused, screen_coach_set_privacy,
        screen_coach_status,
    };
    use screen::coach_mode::screen_coach_pill;
    use screen::notes_check::screen_notes_panel;
    tauri::generate_handler![
        reminders::notify_due,
        screen_coach_status,
        screen_coach_set_enabled,
        screen_coach_set_paused,
        screen_coach_set_hotkey,
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
        screen_coach_spoken,
        screen_draw_mark,
        screen_draw_erase,
        screen_draw_select,
        screen_circle_card
    ]
}

#[cfg(not(windows))]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![reminders::notify_due]
}

/// The web app's pages (and only they) may call these: review reminders, and Screen Coach's
/// two page-facing commands (each also re-checks the calling window in Rust).
fn remote_capability(app: &AppHandle, app_url: &Url) -> tauri::Result<()> {
    app.add_capability(
        CapabilityBuilder::new("mew-web-app")
            .remote(origin::capability_pattern(app_url))
            .local(false)
            .window(MAIN)
            .permission("allow-notify-due")
            .permission("allow-screen-coach-ask")
            .permission("allow-screen-coach-spoken")
            .permission("allow-screen-coach-link-finish"),
    )
}

fn main_window(app: &AppHandle, app_url: Url) -> tauri::Result<WebviewWindow> {
    let allowed = app_url.clone();
    let start = app_url.join("notebook").unwrap_or(app_url);
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(start))
        .title("Mew")
        .inner_size(1280.0, 840.0)
        .min_inner_size(900.0, 600.0)
        .additional_browser_args(BROWSER_ARGS)
        .on_navigation(move |target| origin::may_navigate(&allowed, target))
        // A link opened in a new window (a saved clip's source, say) goes to the default
        // browser, https only; no window of ours ever shows another site.
        .on_new_window(|url, _features| {
            #[cfg(windows)]
            screen::win::system::open_in_browser(&url);
            #[cfg(not(windows))]
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

/// Brings the window back (from the tray, minimised or behind other apps).
fn show(app: &AppHandle) -> Option<WebviewWindow> {
    let window = app.get_webview_window(MAIN)?;
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    Some(window)
}

/// Shows the window and asks Mew to listen, as if the mascot was tapped.
fn summon(app: &AppHandle) {
    if let Some(window) = show(app) {
        let _ = window.eval(SUMMON_SCRIPT);
    }
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Mew", true, None::<&str>)?;
    let ask = MenuItem::with_id(app, "summon", "Ask Mew  (Ctrl+Shift+M)", true, None::<&str>)?;
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
    let stop_walkthrough = MenuItem::with_id(
        app,
        "screen-coach-stop",
        "Stop the walkthrough",
        false,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(
        app,
        "screen-settings",
        "Screen Coach settings…",
        true,
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
            &stop_walkthrough,
            &settings,
            &separator2,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Mew")
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
            "screen-coach-stop" => screen::coach_mode::stop_from_tray(app),
            #[cfg(windows)]
            "screen-settings" => screen::coach::open_settings(app),
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
        stop_walkthrough,
    });
    Ok(())
}

/// Global hotkeys: Ctrl+Shift+M summons Mew; Screen Coach registers its own when it's on.
#[cfg(desktop)]
fn hotkeys(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if is_summon_hotkey(shortcut) {
                    if event.state() == ShortcutState::Pressed {
                        summon(app);
                    }
                    return;
                }
                #[cfg(windows)]
                screen::coach::on_shortcut(app, shortcut, event.state());
            })
            .build(),
    )?;
    // Another app may own the shortcut already; Mew still works without it.
    if let Err(error) = app.global_shortcut().register(summon_hotkey()) {
        eprintln!("Mew: couldn't register Ctrl+Shift+M ({error})");
    }
    Ok(())
}
