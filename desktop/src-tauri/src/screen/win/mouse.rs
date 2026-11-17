//! Mouse input for Neb's hand (`screen_hand.rs`): a click or a turn of the wheel at a point on
//! the screen, and a few plain keys, with `SendInput`.
//!
//! Windows has one mouse cursor, and it's the student's. So Neb's ordinary click is a **touch
//! tap** (`tap_at`, touch injection): it lands on a point without moving the mouse at all, the
//! way a finger on a touch screen does, which is what lets Neb's cursor (an overlay that has
//! already glided there) and the student's mouse be two separate things. What a tap can't do (a
//! right click, the wheel) borrows the real cursor for a few hundredths of a second and puts it
//! straight back (`click_and_return`, `scroll_and_return`).
//! Windows ignores all of this for apps running as administrator.

use std::time::Duration;

use windows::Win32::Foundation::{POINT, RECT};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK,
    MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DOWN,
    VK_END, VK_ESCAPE, VK_F, VK_F5, VK_HOME, VK_L, VK_LEFT, VK_LWIN, VK_MENU, VK_N, VK_NEXT,
    VK_PRIOR, VK_RETURN, VK_RIGHT, VK_S, VK_SHIFT, VK_T, VK_TAB, VK_UP,
};
use windows::Win32::UI::Input::Pointer::{
    InitializeTouchInjection, InjectTouchInput, POINTER_FLAGS, POINTER_FLAG_DOWN,
    POINTER_FLAG_INCONTACT, POINTER_FLAG_INRANGE, POINTER_FLAG_UP, POINTER_INFO,
    POINTER_TOUCH_INFO, TOUCH_FEEDBACK_NONE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, PT_TOUCH, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN, TOUCH_MASK_CONTACTAREA, TOUCH_MASK_ORIENTATION, TOUCH_MASK_PRESSURE,
};

use super::input::cursor;

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

/// A key or shortcut Neb's hand may press: moving about, and a few shortcuts that open or find
/// something. Nothing that closes, deletes, cuts, pastes, sends or runs (no Alt+F4, Ctrl+W,
/// Delete, Ctrl+Enter, Win+R). The same list as `SCREEN_ACT_KEYS` in
/// packages/shared/src/screen-act.ts; anything else in a reply doesn't parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlainKey {
    Enter,
    Escape,
    Tab,
    Backspace,
    Up,
    Down,
    Left,
    Right,
    PageUp,
    PageDown,
    Home,
    End,
    F5,
    /// The Start menu.
    Windows,
    #[serde(rename = "shift+tab")]
    ShiftTab,
    /// Back.
    #[serde(rename = "alt+left")]
    AltLeft,
    #[serde(rename = "ctrl+home")]
    CtrlHome,
    #[serde(rename = "ctrl+end")]
    CtrlEnd,
    /// A browser's address bar.
    #[serde(rename = "ctrl+l")]
    CtrlL,
    /// A new browser tab.
    #[serde(rename = "ctrl+t")]
    CtrlT,
    /// Find.
    #[serde(rename = "ctrl+f")]
    CtrlF,
    /// A new document or window.
    #[serde(rename = "ctrl+n")]
    CtrlN,
    /// Save.
    #[serde(rename = "ctrl+s")]
    CtrlS,
}

impl PlainKey {
    /// The key held meanwhile, if it's a shortcut, and the key pressed.
    pub fn chord(self) -> (Option<VIRTUAL_KEY>, VIRTUAL_KEY) {
        match self {
            Self::Enter => (None, VK_RETURN),
            Self::Escape => (None, VK_ESCAPE),
            Self::Tab => (None, VK_TAB),
            Self::Backspace => (None, VK_BACK),
            Self::Up => (None, VK_UP),
            Self::Down => (None, VK_DOWN),
            Self::Left => (None, VK_LEFT),
            Self::Right => (None, VK_RIGHT),
            Self::PageUp => (None, VK_PRIOR),
            Self::PageDown => (None, VK_NEXT),
            Self::Home => (None, VK_HOME),
            Self::End => (None, VK_END),
            Self::F5 => (None, VK_F5),
            Self::Windows => (None, VK_LWIN),
            Self::ShiftTab => (Some(VK_SHIFT), VK_TAB),
            Self::AltLeft => (Some(VK_MENU), VK_LEFT),
            Self::CtrlHome => (Some(VK_CONTROL), VK_HOME),
            Self::CtrlEnd => (Some(VK_CONTROL), VK_END),
            Self::CtrlL => (Some(VK_CONTROL), VK_L),
            Self::CtrlT => (Some(VK_CONTROL), VK_T),
            Self::CtrlF => (Some(VK_CONTROL), VK_F),
            Self::CtrlN => (Some(VK_CONTROL), VK_N),
            Self::CtrlS => (Some(VK_CONTROL), VK_S),
        }
    }

    /// As it's said in the history ("Pressed Ctrl+L.").
    pub fn name(self) -> &'static str {
        match self {
            Self::Enter => "Enter",
            Self::Escape => "Escape",
            Self::Tab => "Tab",
            Self::Backspace => "Backspace",
            Self::Up => "Up",
            Self::Down => "Down",
            Self::Left => "Left",
            Self::Right => "Right",
            Self::PageUp => "Page Up",
            Self::PageDown => "Page Down",
            Self::Home => "Home",
            Self::End => "End",
            Self::F5 => "F5",
            Self::Windows => "the Windows key",
            Self::ShiftTab => "Shift+Tab",
            Self::AltLeft => "Alt+Left",
            Self::CtrlHome => "Ctrl+Home",
            Self::CtrlEnd => "Ctrl+End",
            Self::CtrlL => "Ctrl+L",
            Self::CtrlT => "Ctrl+T",
            Self::CtrlF => "Ctrl+F",
            Self::CtrlN => "Ctrl+N",
            Self::CtrlS => "Ctrl+S",
        }
    }
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
fn click_at(x: i32, y: i32, button: Button, double: bool) -> bool {
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
fn scroll_at(x: i32, y: i32, notches: i32) -> bool {
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

/// One finger at a screen point, going down or coming up.
fn contact(x: i32, y: i32, flags: POINTER_FLAGS) -> POINTER_TOUCH_INFO {
    POINTER_TOUCH_INFO {
        pointerInfo: POINTER_INFO {
            pointerType: PT_TOUCH,
            pointerId: 0,
            pointerFlags: flags,
            ptPixelLocation: POINT { x, y },
            ..Default::default()
        },
        touchMask: TOUCH_MASK_CONTACTAREA | TOUCH_MASK_ORIENTATION | TOUCH_MASK_PRESSURE,
        // A fingertip: a few pixels across, pressing lightly, upright.
        rcContact: RECT {
            left: x - 2,
            top: y - 2,
            right: x + 2,
            bottom: y + 2,
        },
        orientation: 90,
        pressure: 32000,
        ..Default::default()
    }
}

/// Taps a screen point as a finger would (twice for `double`), without moving the mouse. False
/// if Windows doesn't take touch input here, or refused it: the caller clicks with the mouse.
pub fn tap_at(x: i32, y: i32, double: bool) -> bool {
    // SAFETY: plain value arguments; sets this app up to send one touch contact at a time, with
    // none of Windows' own touch ripples (Neb's cursor shows the click).
    if unsafe { InitializeTouchInjection(1, TOUCH_FEEDBACK_NONE) }.is_err() {
        return false;
    }
    let tap = || {
        let down = [contact(
            x,
            y,
            POINTER_FLAG_DOWN | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT,
        )];
        // SAFETY: a valid slice of one initialised contact for the call.
        if unsafe { InjectTouchInput(&down) }.is_err() {
            return false;
        }
        std::thread::sleep(BEAT);
        // The finger always comes up again, even if that fails to be delivered.
        // SAFETY: as above.
        unsafe { InjectTouchInput(&[contact(x, y, POINTER_FLAG_UP)]) }.is_ok()
    };
    if !tap() {
        return false;
    }
    if double {
        std::thread::sleep(BEAT * 2);
        return tap();
    }
    true
}

/// Runs `act` (which moves the real cursor), then puts the cursor back where the student had
/// it.
fn and_return(act: impl FnOnce() -> bool) -> bool {
    let before = cursor();
    let done = act();
    std::thread::sleep(BEAT);
    if let Some((x, y)) = before {
        move_to(x, y);
    }
    done
}

/// Clicks at a screen point with the real mouse, and puts it straight back.
pub fn click_and_return(x: i32, y: i32, button: Button, double: bool) -> bool {
    and_return(|| click_at(x, y, button, double))
}

/// Turns the wheel over a screen point, and puts the real mouse straight back.
pub fn scroll_and_return(x: i32, y: i32, notches: i32) -> bool {
    and_return(|| scroll_at(x, y, notches))
}

/// Presses and lets go of one key, or one shortcut (its modifier held meanwhile, and always let
/// go again, in the same batch of input).
pub fn press(key: PlainKey) -> bool {
    let event = |vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS| INPUT {
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
    let down = KEYBD_EVENT_FLAGS(0);
    match key.chord() {
        (None, vk) => send(&[event(vk, down), event(vk, KEYEVENTF_KEYUP)]),
        (Some(held), vk) => send(&[
            event(held, down),
            event(vk, down),
            event(vk, KEYEVENTF_KEYUP),
            event(held, KEYEVENTF_KEYUP),
        ]),
    }
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

    fn key(name: &str) -> Option<PlainKey> {
        serde_json::from_value(serde_json::Value::String(name.into())).ok()
    }

    #[test]
    fn reads_the_keys_and_shortcuts_it_may_press_and_no_others() {
        assert_eq!(key("enter"), Some(PlainKey::Enter));
        assert_eq!(key("page_down"), Some(PlainKey::PageDown));
        assert_eq!(key("windows"), Some(PlainKey::Windows));
        assert_eq!(key("ctrl+l"), Some(PlainKey::CtrlL));
        assert_eq!(key("shift+tab"), Some(PlainKey::ShiftTab));
        assert_eq!(PlainKey::CtrlS.chord(), (Some(VK_CONTROL), VK_S));
        assert_eq!(PlainKey::AltLeft.chord(), (Some(VK_MENU), VK_LEFT));
        assert_eq!(PlainKey::Home.chord(), (None, VK_HOME));
        // Nothing that closes, deletes, pastes, sends or runs.
        for name in [
            "alt+f4",
            "ctrl+w",
            "delete",
            "ctrl+v",
            "ctrl+x",
            "ctrl+a",
            "ctrl+enter",
            "win+r",
            "ctrl+shift+esc",
            "CtrlL",
            "ctrl_l",
        ] {
            assert_eq!(key(name), None, "{name}");
        }
    }
}
