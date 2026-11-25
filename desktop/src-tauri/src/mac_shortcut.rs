//! Fixed Mac summon shortcut. The hosted page can inspect status, never register shortcuts.
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, Url, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

struct Status {
    app_url: Url,
    registered: bool,
}

fn shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyN)
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
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, key, event| {
            if key == &shortcut() && latch.update(event.state()) {
                crate::summon(app);
            }
            if key == &Shortcut::new(None, Code::Escape) && event.state() == ShortcutState::Pressed
            {
                let _ = crate::screen::mac::drawing::close(app);
                let _ = crate::screen::mac::island::hide(app);
            }
        })
        .build();
    // A conflict must leave Neb usable through its Dock and menu-bar item.
    let registered =
        app.plugin(plugin).is_ok() && app.global_shortcut().register(shortcut()).is_ok();
    app.manage(Status {
        app_url,
        registered,
    });
}

pub fn registered(app: &AppHandle) -> bool {
    app.state::<Status>().registered
}

#[tauri::command]
pub fn desktop_summon_shortcut(window: WebviewWindow) -> Result<bool, String> {
    let status = window.state::<Status>();
    crate::screen::page::require_app_page(&window, &status.app_url)?;
    Ok(status.registered)
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
