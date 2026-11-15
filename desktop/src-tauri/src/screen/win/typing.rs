//! Typing text into the app in front, as if from the keyboard (typing into a document,
//! `screen_write.rs`): `SendInput` with Unicode key events, a few characters at a time.
//!
//! Typing stops at once if the window in front changes, or the student presses Esc. It never
//! starts while a modifier key is held (Ctrl or Alt with a letter would be a shortcut), and the
//! only keys it ever sends besides characters are Enter (a new line) and Tab.

use std::time::{Duration, Instant};

use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_CONTROL, VK_ESCAPE, VK_LWIN, VK_MENU,
    VK_RETURN, VK_RWIN, VK_SHIFT, VK_TAB,
};

use super::input::foreground;

/// Characters sent per `SendInput` call, and the pause between calls (apps that redraw on
/// every key, like Word, keep up).
const CHUNK: usize = 12;
const PAUSE: Duration = Duration::from_millis(10);
/// How long to wait for the student to let go of Ctrl, Alt, Shift or Windows.
const MODIFIER_WAIT: Duration = Duration::from_secs(3);

/// How typing ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Typed {
    All,
    /// Stopped part way: the window in front changed.
    WindowChanged,
    /// Stopped part way: the student pressed Esc.
    Cancelled,
    /// Never started: a modifier key stayed down.
    KeysHeld,
    /// Windows refused the keys (an app running as administrator ignores them).
    Refused,
}

/// One key: a character, or Enter or Tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Unit(u16),
    Virtual(u16),
}

/// The keys for `text`: UTF-16 units, Enter for each new line, Tab for tabs. Other control
/// characters are dropped (the server never sends them; this is the last guard).
pub fn keys_for(text: &str) -> Vec<Key> {
    let mut keys = Vec::with_capacity(text.len());
    let mut buf = [0u16; 2];
    for c in text.chars() {
        match c {
            '\n' => keys.push(Key::Virtual(VK_RETURN.0)),
            '\t' => keys.push(Key::Virtual(VK_TAB.0)),
            c if c.is_control() => {}
            c => keys.extend(c.encode_utf16(&mut buf).iter().map(|&u| Key::Unit(u))),
        }
    }
    keys
}

fn down(key: VIRTUAL_KEY) -> bool {
    // SAFETY: a plain value argument; reads the key's state only.
    let state = unsafe { GetAsyncKeyState(i32::from(key.0)) };
    state < 0
}

fn modifiers_down() -> bool {
    [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
        .into_iter()
        .any(down)
}

fn event(key: Key, up: bool) -> INPUT {
    let (vk, scan, mut flags) = match key {
        Key::Unit(unit) => (VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE),
        Key::Virtual(vk) => (VIRTUAL_KEY(vk), 0, KEYBD_EVENT_FLAGS(0)),
    };
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Types `text` into `window` (a raw HWND from `input::foreground`), which must stay in front.
pub fn type_into(window: isize, text: &str) -> Typed {
    let waited = Instant::now();
    while modifiers_down() {
        if waited.elapsed() >= MODIFIER_WAIT {
            return Typed::KeysHeld;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // Clears Esc's "pressed since" bit, so only a press from now on cancels.
    // SAFETY: a plain value argument; reads the key's state only.
    let _ = unsafe { GetAsyncKeyState(i32::from(VK_ESCAPE.0)) };
    for chunk in keys_for(text).chunks(CHUNK) {
        if foreground() != window {
            return Typed::WindowChanged;
        }
        // SAFETY: as above.
        if unsafe { GetAsyncKeyState(i32::from(VK_ESCAPE.0)) } as u16 & 0x8001 != 0 {
            return Typed::Cancelled;
        }
        let inputs: Vec<INPUT> = chunk
            .iter()
            .flat_map(|&key| [event(key, false), event(key, true)])
            .collect();
        // SAFETY: `inputs` is a valid slice of initialised INPUT structs for the call, and the
        // size passed is that of one INPUT, as the API requires.
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != inputs.len() {
            return Typed::Refused;
        }
        std::thread::sleep(PAUSE);
    }
    Typed::All
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_lines_are_enter_and_other_controls_are_dropped() {
        assert_eq!(
            keys_for("a\nb\tc\u{1b}"),
            vec![
                Key::Unit(u16::from(b'a')),
                Key::Virtual(VK_RETURN.0),
                Key::Unit(u16::from(b'b')),
                Key::Virtual(VK_TAB.0),
                Key::Unit(u16::from(b'c')),
            ]
        );
    }

    #[test]
    fn characters_beyond_the_basic_plane_are_two_units() {
        assert_eq!(keys_for("é∑😀").len(), 4);
    }
}
