//! Mew for Windows: a window onto the Mew web app, plus what a web page can't do on its own:
//! a global hotkey to summon Mew from any app, a tray icon, and review reminders.
//!
//! Security: the window shows a remote origin (the web app). That origin gets exactly one
//! permission, calling `notify_due`; everything else (hotkey, tray, window) happens in Rust.

mod origin;
mod reminders;

use tauri::{
    ipc::CapabilityBuilder,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use reminders::Reminders;

const MAIN: &str = "main";
/// Tells the page to summon Mew (it listens for this event; see the web app's desktop bridge).
const SUMMON_SCRIPT: &str = "window.dispatchEvent(new CustomEvent('mew:summon'))";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_url = origin::app_url(std::env::var("MEW_APP_URL").ok());
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(Reminders::default())
        .invoke_handler(tauri::generate_handler![reminders::notify_due])
        .setup(move |app| {
            remote_capability(app.handle(), &app_url)?;
            let window = main_window(app.handle(), app_url.clone())?;
            tray(app.handle())?;
            #[cfg(desktop)]
            summon_hotkey(app.handle())?;
            let _ = window.set_focus();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Mew");
}

/// The web app's pages (and only they) may call `notify_due`.
fn remote_capability(app: &AppHandle, app_url: &Url) -> tauri::Result<()> {
    app.add_capability(
        CapabilityBuilder::new("mew-web-app")
            .remote(origin::capability_pattern(app_url))
            .local(false)
            .window(MAIN)
            .permission("allow-notify-due"),
    )
}

fn main_window(app: &AppHandle, app_url: Url) -> tauri::Result<WebviewWindow> {
    let allowed = app_url.clone();
    let start = app_url.join("notebook").unwrap_or(app_url);
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(start))
        .title("Mew")
        .inner_size(1280.0, 840.0)
        .min_inner_size(900.0, 600.0)
        .on_navigation(move |target| origin::may_navigate(&allowed, target))
        .build()?;
    // Closing the window keeps Mew in the tray, so the hotkey and reminders keep working.
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
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &ask, &quit])?;
    let mut builder = TrayIconBuilder::with_id("mew")
        .tooltip("Mew")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                show(app);
            }
            "summon" => summon(app),
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
    Ok(())
}

/// Ctrl+Shift+M from any app: Mew comes forward and listens.
#[cfg(desktop)]
fn summon_hotkey(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };

    let hotkey = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyM);
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if shortcut == &hotkey && event.state() == ShortcutState::Pressed {
                    summon(app);
                }
            })
            .build(),
    )?;
    // Another app may own the shortcut already; Mew still works without it.
    if let Err(error) = app.global_shortcut().register(hotkey) {
        eprintln!("Mew: couldn't register Ctrl+Shift+M ({error})");
    }
    Ok(())
}
