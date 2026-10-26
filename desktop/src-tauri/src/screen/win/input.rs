//! Reading the hold keys, the primary mouse button and the cursor (Circle & Ask, decision 11; the
//! hold gesture, K2), and handing the focus back after keyboard drawing.
//!
//! No hooks: `GetAsyncKeyState` for left Ctrl and left Alt (AltGr, which is right Alt plus Ctrl,
//! never counts) and for the primary button, and `GetCursorPos`. While both hold keys are down,
//! `other_key_down` asks whether any other key is (the AltGr guard); it answers yes or no, never
//! which key. Nothing is recorded; the caller only acts on "held or not" and "where is the
//! cursor".

use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_LBUTTON, VK_LCONTROL, VK_LMENU, VK_RBUTTON, VK_RMENU,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetSystemMetrics, IsWindow, SetForegroundWindow,
    SM_SWAPBUTTON,
};

/// Left Ctrl and left Alt are both held (and right Alt isn't: that's AltGr typing).
pub fn hold_keys_held() -> bool {
    // SAFETY: plain value arguments; reads the keys' state only.
    let down = |key| unsafe { GetAsyncKeyState(i32::from(key)) } < 0;
    down(VK_LCONTROL.0) && down(VK_LMENU.0) && !down(VK_RMENU.0)
}

/// Virtual keys that never spoil the hold: mouse buttons (they draw), and Ctrl and Alt.
fn ignored(key: u16) -> bool {
    matches!(key, 0x01..=0x06 | 0x11 | 0x12 | 0xA2..=0xA5)
}

/// Any key other than Ctrl, Alt and the mouse buttons is down, or was pressed since the last
/// call (a quick key between two polls). The first call after the hold keys went down is a
/// `flush`: it clears the "pressed since" bits left from earlier typing and answers only for keys
/// down now.
pub fn other_key_down(flush: bool) -> bool {
    let mut any = false;
    for key in 0x08u16..=0xFE {
        if ignored(key) {
            continue;
        }
        // SAFETY: a plain value argument; reads the key's state only.
        let state = unsafe { GetAsyncKeyState(i32::from(key)) } as u16;
        // Every key is read (no early return): each read clears its "pressed since" bit.
        any |= state & 0x8000 != 0 || (state & 0x0001 != 0 && !flush);
    }
    any
}

/// The primary mouse button is down (drawing with the mouse, `drag.rs`). `GetAsyncKeyState`
/// reads the physical buttons, so with the buttons swapped the primary one is the right.
pub fn primary_button_down() -> bool {
    // SAFETY: plain value arguments; read the setting and the button's state only.
    let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
    let button = if swapped { VK_RBUTTON } else { VK_LBUTTON };
    let state = unsafe { GetAsyncKeyState(i32::from(button.0)) };
    state < 0
}

/// Where the cursor is, in screen pixels.
pub fn cursor() -> Option<(i32, i32)> {
    let mut point = POINT::default();
    // SAFETY: `point` is a valid out pointer for the duration of the call.
    unsafe { GetCursorPos(&mut point) }.ok()?;
    Some((point.x, point.y))
}

/// The window in front, as a raw handle (to give the focus back to it later).
pub fn foreground() -> isize {
    // SAFETY: no arguments.
    unsafe { GetForegroundWindow() }.0 as isize
}

/// Gives the focus back to `raw` (from `foreground`), if it still exists.
pub fn give_focus_back(raw: isize) {
    let hwnd = HWND(raw as *mut _);
    // SAFETY: plain value arguments; Windows validates the handle (it may have closed).
    if raw != 0 && unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        // SAFETY: as above. Windows may refuse (focus rules); then the student clicks.
        let _ = unsafe { SetForegroundWindow(hwnd) };
    }
}
