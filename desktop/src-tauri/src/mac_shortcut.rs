//! Fixed Mac summon shortcut. The hosted page can inspect status, never register shortcuts.
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, Url, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

struct Status {
    app_url: Url,
    registered: bool,
    voice_registered: bool,
    tools_registered: bool,
    plugin_ready: bool,
}

fn shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyN)
}
fn tools_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyI)
}
fn voice_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space)
}

#[derive(Default)]
struct PressLatch(AtomicBool);

impl PressLatch {
    fn update(&self, state: ShortcutState) -> bool {
        let pressed = state == ShortcutState::Pressed;
        if pressed {
            !self.0.swap(true, Ordering::Relaxed)
        } else {
            self.0.store(false, Ordering::Relaxed);
            false
        }
    }
}

pub fn setup(app: &AppHandle, app_url: Url) {
    let latch = PressLatch::default();
    let tools_latch = PressLatch::default();
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, key, event| {
            if key == &shortcut() && latch.update(event.state()) {
                crate::summon(app);
            }
            if key == &tools_shortcut() && tools_latch.update(event.state()) {
                let _ = crate::screen::mac::runtime::toggle_island(app);
            }
            if key == &voice_shortcut() {
                let listening = crate::screen::mac::ask::listening(app);
                if (event.state() == ShortcutState::Pressed && !listening)
                    || (event.state() == ShortcutState::Released && listening)
                {
                    let _ = crate::screen::mac::ask::toggle_mic(app);
                }
            }
            if key == &Shortcut::new(None, Code::Escape) && event.state() == ShortcutState::Pressed
            {
                crate::screen::mac::runtime::cancel(app);
                let _ = crate::screen::mac::drawing::close(app);
                let _ = crate::screen::mac::island::hide(app);
            }
        })
        .build();
    // A conflict must leave Neb usable through its Dock and menu-bar item.
    let plugin_ready = app.plugin(plugin).is_ok();
    let registered = plugin_ready && app.global_shortcut().register(shortcut()).is_ok();
    // A conflict leaves the microphone button available. Never replace another app's key.
    let tools_registered = plugin_ready && app.global_shortcut().register(tools_shortcut()).is_ok();
    let voice_registered = plugin_ready && app.global_shortcut().register(voice_shortcut()).is_ok();
    app.manage(Status {
        app_url,
        registered,
        voice_registered,
        tools_registered,
        plugin_ready,
    });
}

pub fn registered(app: &AppHandle) -> bool {
    app.state::<Status>().registered
}

pub fn tools_registered(app: &AppHandle) -> bool {
    app.try_state::<Status>()
        .is_some_and(|s| s.tools_registered)
}
pub fn voice_registered(app: &AppHandle) -> bool {
    app.try_state::<Status>()
        .is_some_and(|s| s.voice_registered)
}

#[tauri::command]
pub fn desktop_summon_shortcut(window: WebviewWindow) -> Result<bool, String> {
    let status = window.state::<Status>();
    crate::screen::page::require_app_page(&window, &status.app_url)?;
    Ok(status.registered)
}

/// Shared Escape ownership: drawing cleanup cannot remove the island's cancellation key.
pub(crate) fn reserve_escape(app: &AppHandle) -> Result<(), String> {
    let Some(status) = app.try_state::<Status>() else {
        return Ok(());
    }; // owned panel fixture
    if !status.plugin_ready {
        return Err("Global keyboard cancellation is unavailable.".into());
    }
    let key = Shortcut::new(None, Code::Escape);
    if !app.global_shortcut().is_registered(key) {
        app.global_shortcut()
            .register(key)
            .map_err(|_| "Couldn't register Escape for Neb tools.")?;
    }
    Ok(())
}
pub(crate) fn release_escape(app: &AppHandle) {
    if !app
        .try_state::<Status>()
        .is_some_and(|status| status.plugin_ready)
    {
        return;
    }
    if crate::screen::mac::island::shown(app)
        || crate::screen::mac::drawing::view(app).0.draws()
        || crate::screen::mac::annotate::visible(app)
        || crate::screen::mac::ask::engaged(app)
    {
        return;
    }
    let _ = app
        .global_shortcut()
        .unregister(Shortcut::new(None, Code::Escape));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn held_shortcut_summons_once_until_released() {
        let latch = PressLatch::default();
        assert!(!latch.update(ShortcutState::Released));
        assert!(latch.update(ShortcutState::Pressed));
        assert!(!latch.update(ShortcutState::Pressed));
        assert!(!latch.update(ShortcutState::Released));
        assert!(latch.update(ShortcutState::Pressed));
    }

    #[test]
    fn uses_control_shift_n_not_command_or_voiceover_modifiers() {
        assert_eq!(shortcut(), "Control+Shift+N".parse::<Shortcut>().unwrap());
        assert_ne!(shortcut(), "Command+Shift+N".parse::<Shortcut>().unwrap());
        assert_ne!(shortcut(), "Control+Alt+N".parse::<Shortcut>().unwrap());
    }
}
