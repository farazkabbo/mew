//! Mew for Windows: a window onto the Mew web app, plus what a web page can't do on its own:
//! a global hotkey to summon Mew from any app, a tray icon, review reminders, and Screen Coach
//! (docs/SCREEN_COACH.md).
//!
//! Security: the window shows a remote origin (the web app). That origin gets exactly one
//! permission, calling `notify_due`; everything else (hotkeys, tray, window, screen capture)
//! happens in Rust. Screen Coach's settings commands are granted to its bundled local page only.

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

const MAIN: &str = "main";
pub const TRAY_ID: &str = "mew";
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
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(Reminders::default())
        .invoke_handler(handlers())
        .setup(move |app| {
            remote_capability(app.handle(), &app_url)?;
            let window = main_window(app.handle(), app_url.clone())?;
            tray(app.handle())?;
            #[cfg(desktop)]
            hotkeys(app.handle())?;
            #[cfg(windows)]
            screen::coach::setup(app.handle())?;
            let _ = window.set_focus();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Mew");
}

#[cfg(windows)]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    use screen::coach::{
        screen_coach_set_enabled, screen_coach_set_hotkey, screen_coach_set_paused,
        screen_coach_status,
    };
    tauri::generate_handler![
        reminders::notify_due,
        screen_coach_status,
        screen_coach_set_enabled,
        screen_coach_set_paused,
        screen_coach_set_hotkey
    ]
}

#[cfg(not(windows))]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![reminders::notify_due]
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
    app.manage(screen::coach::TrayItems { look, pause });
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
