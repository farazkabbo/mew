//! Reading the two drawing keys, the primary mouse button and the cursor (Circle & Ask, decision
//! 11), and handing the focus back after keyboard drawing.
//!
//! No hooks: `GetAsyncKeyState` for left Ctrl and left Alt only (AltGr, which is right Alt plus
//! Ctrl, never draws) and for the primary button, and `GetCursorPos`. Nothing is recorded; the caller only acts on "held or
//! not" and "where is the cursor".

use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_LBUTTON, VK_LCONTROL, VK_LMENU, VK_RBUTTON, VK_RMENU,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetSystemMetrics, IsWindow, SetForegroundWindow,
    SM_SWAPBUTTON,
};

/// Left Ctrl and left Alt are both held (and right Alt isn't: that's AltGr typing).
pub fn draw_keys_held() -> bool {
    // SAFETY: plain value arguments; reads the keys' state only.
    let down = |key| unsafe { GetAsyncKeyState(i32::from(key)) } < 0;
    down(VK_LCONTROL.0) && down(VK_LMENU.0) && !down(VK_RMENU.0)
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
