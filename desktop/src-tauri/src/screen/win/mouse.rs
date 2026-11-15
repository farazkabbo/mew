//! Mouse input for Neb's hand (`screen_hand.rs`): a click or a turn of the wheel at a point on
//! the screen, and a few plain keys, with `SendInput`.
//!
//! Windows has one real cursor, so a click happens where it is: the real cursor is put on the
//! point for the click (Neb's own cursor, an overlay, has already glided there, so the student
//! sees Neb do it). `screen_hand.rs` puts it back where the student left it when it's done.
//! Windows ignores this input for apps running as administrator.

use std::time::Duration;

use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK,
    MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY, VK_BACK, VK_ESCAPE, VK_RETURN,
    VK_TAB,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

/// One notch of the wheel.
const WHEEL_DELTA: i32 = 120;
/// Between moving and pressing, and between the two clicks of a double click: long enough for
/// the app under the cursor to notice each.
const BEAT: Duration = Duration::from_millis(45);

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Button {
    Left,
    Right,
}

/// A key Neb's hand may press (never a shortcut: no modifiers).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlainKey {
    Enter,
    Escape,
    Tab,
    Backspace,
}

/// The virtual desktop (every monitor), in screen pixels: left, top, width, height.
fn desktop() -> (i32, i32, i32, i32) {
    // SAFETY: plain value arguments; reads system metrics only.
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

/// A screen point as `SendInput` wants it: 0–65535 across and down the virtual desktop.
pub fn absolute(x: i32, y: i32, desktop: (i32, i32, i32, i32)) -> (i32, i32) {
    let (left, top, width, height) = desktop;
    let scale = |v: i32, start: i32, size: i32| {
        let span = i64::from(size.max(2) - 1);
        ((i64::from(v - start).clamp(0, span) * 65535 + span / 2) / span) as i32
    };
    (scale(x, left, width), scale(y, top, height))
}

fn mouse(flags: MOUSE_EVENT_FLAGS, at: (i32, i32), data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: at.0,
                dy: at.1,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send(inputs: &[INPUT]) -> bool {
    // SAFETY: `inputs` is a valid slice of initialised INPUT structs for the call, and the size
    // passed is that of one INPUT, as the API requires.
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    sent as usize == inputs.len()
}

/// Puts the real cursor at a screen point.
pub fn move_to(x: i32, y: i32) -> bool {
    let at = absolute(x, y, desktop());
    send(&[mouse(
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        at,
        0,
    )])
}

/// Clicks at a screen point (the real cursor stays there). False if Windows refused the input.
pub fn click_at(x: i32, y: i32, button: Button, double: bool) -> bool {
    if !move_to(x, y) {
        return false;
    }
    std::thread::sleep(BEAT);
    let (down, up) = match button {
        Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    };
    let press = [mouse(down, (0, 0), 0), mouse(up, (0, 0), 0)];
    if !send(&press) {
        return false;
    }
    if double {
        std::thread::sleep(BEAT);
        return send(&press);
    }
    true
}

/// Turns the wheel over a screen point: `notches` up (positive) or down (negative).
pub fn scroll_at(x: i32, y: i32, notches: i32) -> bool {
    if !move_to(x, y) {
        return false;
    }
    std::thread::sleep(BEAT);
    // A notch at a time, as a wheel does: some apps ignore one big turn.
    for _ in 0..notches.unsigned_abs() {
        if !send(&[mouse(
            MOUSEEVENTF_WHEEL,
            (0, 0),
            WHEEL_DELTA * notches.signum(),
        )]) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    true
}

/// Presses and lets go of one plain key.
pub fn press(key: PlainKey) -> bool {
    let vk: VIRTUAL_KEY = match key {
        PlainKey::Enter => VK_RETURN,
        PlainKey::Escape => VK_ESCAPE,
        PlainKey::Tab => VK_TAB,
        PlainKey::Backspace => VK_BACK,
    };
    let event = |flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    send(&[event(KEYBD_EVENT_FLAGS(0)), event(KEYEVENTF_KEYUP)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_point_is_scaled_over_every_monitor() {
        // Two 1920×1080 monitors, the second to the left of the first.
        let desktop = (-1920, 0, 3840, 1080);
        assert_eq!(absolute(-1920, 0, desktop), (0, 0));
        assert_eq!(absolute(1919, 1079, desktop), (65535, 65535));
        let (x, y) = absolute(0, 540, desktop);
        assert!((32760..=32780).contains(&x), "{x}");
        assert!((32770..=32800).contains(&y), "{y}");
        // Off the desktop: kept on it.
        assert_eq!(absolute(9000, -50, desktop), (65535, 0));
    }
}
