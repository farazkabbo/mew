//! CATCH ME's chip (docs/CURSOR_MODES.md, G): the catch's line with three small buttons,
//! "Continue", "Not a mistake" and "Snooze 1 h", near the cursor but never over the control the
//! student was heading for. It never takes the focus (the app in front keeps the keyboard), it
//! never blocks anything, and it closes by itself after a few seconds. The click on the risky
//! control itself still goes through: the chip only says what it saw.

use std::sync::mpsc::Sender;
use std::sync::Once;
use std::time::{Duration, Instant};

use windows::core::{w, HSTRING};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreateRoundRectRgn, CreateSolidBrush, DeleteObject, DrawTextW,
    EndPaint, FillRect, FrameRgn, SelectObject, SetBkMode, SetTextColor, SetWindowRgn,
    CLEARTYPE_QUALITY, DEFAULT_CHARSET, DT_CENTER, DT_LEFT, DT_SINGLELINE, DT_VCENTER, FW_NORMAL,
    FW_SEMIBOLD, OUT_DEFAULT_PRECIS, PAINTSTRUCT, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetWindowLongPtrW,
    PeekMessageW, RegisterClassExW, SetWindowDisplayAffinity, SetWindowLongPtrW, ShowWindow,
    TranslateMessage, GWLP_USERDATA, MA_NOACTIVATE, MSG, PM_REMOVE, SW_SHOWNOACTIVATE,
    WDA_EXCLUDEFROMCAPTURE, WM_LBUTTONUP, WM_MOUSEACTIVATE, WM_PAINT, WNDCLASSEXW,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

use crate::screen::cursor::catch::Outcome;
use crate::screen::cursor::scene::intersects;
use crate::screen::frame::ScreenRect;

static REGISTER: Once = Once::new();
/// How long the chip stays when nothing is pressed.
const SHOWN_FOR: Duration = Duration::from_secs(8);
pub const WIDTH_AT_100: i32 = 380;
pub const HEIGHT_AT_100: i32 = 76;
const BUTTONS: [(&str, Outcome); 3] = [
    ("Continue", Outcome::Continued),
    ("Not a mistake", Outcome::NotAMistake),
    ("Snooze 1 h", Outcome::Snoozed),
];

/// Where the chip goes: beside the cursor, on its monitor, clear of the risky control (padded)
/// and of the cursor itself.
pub fn place(
    cursor: (i32, i32),
    avoid: Option<ScreenRect>,
    monitor: ScreenRect,
    scale: f32,
) -> ScreenRect {
    let (w, h) = (
        (WIDTH_AT_100 as f32 * scale) as i32,
        (HEIGHT_AT_100 as f32 * scale) as i32,
    );
    let gap = (28.0 * scale) as i32;
    let candidates = [
        (cursor.0 + gap, cursor.1 + gap),
        (cursor.0 + gap, cursor.1 - gap - h),
        (cursor.0 - gap - w, cursor.1 + gap),
        (cursor.0 - gap - w, cursor.1 - gap - h),
    ];
    let pad = (24.0 * scale) as i32;
    let blocked = avoid.map(|a| ScreenRect {
        left: a.left - pad,
        top: a.top - pad,
        right: a.right + pad,
        bottom: a.bottom + pad,
    });
    let rect_at = |(x, y): (i32, i32)| {
        let x = x.clamp(monitor.left, (monitor.right - w).max(monitor.left));
        let y = y.clamp(monitor.top, (monitor.bottom - h).max(monitor.top));
        ScreenRect {
            left: x,
            top: y,
            right: x + w,
            bottom: y + h,
        }
    };
    candidates
        .iter()
        .map(|c| rect_at(*c))
        .find(|r| blocked.is_none_or(|b| !intersects(*r, b)) && !r.contains(cursor.0, cursor.1))
        .unwrap_or_else(|| rect_at(candidates[0]))
}

/// The buttons' rectangles inside a chip of this size.
fn buttons(w: i32, h: i32, scale: f32) -> [RECT; 3] {
    let pad = (10.0 * scale) as i32;
    let top = h / 2 + pad / 4;
    let bottom = h - pad;
    let width = (w - pad * 4) / 3;
    std::array::from_fn(|i| {
        let left = pad + i as i32 * (width + pad);
        RECT {
            left,
            top,
            right: left + width,
            bottom,
        }
    })
}

struct Chip {
    text: HSTRING,
    scale: f32,
    answer: Option<Sender<Outcome>>,
}

/// Shows the chip on its own thread; the student's choice (or `Shown` if it timed out) goes to
/// `answer`.
pub fn show(
    at: ScreenRect,
    scale: f32,
    text: String,
    show_in_captures: bool,
    answer: Sender<Outcome>,
) {
    let _ = std::thread::Builder::new()
        .name("mew-catch-chip".into())
        .spawn(move || {
            if run(at, scale, &text, show_in_captures, answer.clone()).is_err() {
                let _ = answer.send(Outcome::Shown);
            }
        });
}

fn run(
    at: ScreenRect,
    scale: f32,
    text: &str,
    show_in_captures: bool,
    answer: Sender<Outcome>,
) -> windows::core::Result<()> {
    // SAFETY: a window class registered once with a valid procedure; the window is created,
    // used and destroyed on this thread; the Chip it points to outlives it.
    unsafe {
        let instance = GetModuleHandleW(None)?;
        REGISTER.call_once(|| {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(window_proc),
                hInstance: instance.into(),
                lpszClassName: w!("MewCatchChip"),
                ..Default::default()
            };
            RegisterClassExW(&class);
        });
        let mut chip = Box::new(Chip {
            text: HSTRING::from(text),
            scale,
            answer: Some(answer),
        });
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            w!("MewCatchChip"),
            w!("Neb"),
            WS_POPUP,
            at.left,
            at.top,
            at.width(),
            at.height(),
            None,
            None,
            Some(instance.into()),
            None,
        )?;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, &mut *chip as *mut Chip as isize);
        let radius = (18.0 * scale) as i32;
        let region = CreateRoundRectRgn(0, 0, at.width() + 1, at.height() + 1, radius, radius);
        SetWindowRgn(hwnd, Some(region), true);
        if !show_in_captures {
            let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
        }
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let until = Instant::now() + SHOWN_FOR;
        let mut msg = MSG::default();
        while Instant::now() < until && chip.answer.is_some() {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        let _ = DestroyWindow(hwnd);
        if let Some(answer) = chip.answer.take() {
            let _ = answer.send(Outcome::Shown);
        }
    }
    Ok(())
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: USERDATA is the Chip set in `run` (or 0 once it's going away).
    let chip = unsafe { (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Chip).as_mut() };
    match (msg, chip) {
        // Clicks never move the focus here.
        (WM_MOUSEACTIVATE, _) => LRESULT(MA_NOACTIVATE as isize),
        (WM_LBUTTONUP, Some(chip)) => {
            let (x, y) = (
                (lparam.0 & 0xffff) as i16 as i32,
                ((lparam.0 >> 16) & 0xffff) as i16 as i32,
            );
            let (w, h) = (
                (WIDTH_AT_100 as f32 * chip.scale) as i32,
                (HEIGHT_AT_100 as f32 * chip.scale) as i32,
            );
            for (rect, (_, outcome)) in buttons(w, h, chip.scale).iter().zip(BUTTONS) {
                if x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom {
                    if let Some(answer) = chip.answer.take() {
                        let _ = answer.send(outcome);
                    }
                }
            }
            LRESULT(0)
        }
        (WM_PAINT, Some(chip)) => {
            // SAFETY: standard painting of our own window with GDI objects freed below.
            unsafe { paint(hwnd, chip) };
            LRESULT(0)
        }
        // SAFETY: default handling for our own window.
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

unsafe fn paint(hwnd: HWND, chip: &Chip) {
    let s = chip.scale;
    let (w, h) = (
        (WIDTH_AT_100 as f32 * s) as i32,
        (HEIGHT_AT_100 as f32 * s) as i32,
    );
    let mut ps = PAINTSTRUCT::default();
    // SAFETY: per the function contract (called from WM_PAINT on our window).
    unsafe {
        let dc = BeginPaint(hwnd, &mut ps);
        let background = CreateSolidBrush(COLORREF(0x002E_1B1F));
        FillRect(
            dc,
            &RECT {
                left: 0,
                top: 0,
                right: w,
                bottom: h,
            },
            background,
        );
        let amber = CreateSolidBrush(COLORREF(0x0024_A5F5));
        let radius = (18.0 * s) as i32;
        let edge = CreateRoundRectRgn(0, 0, w, h, radius, radius);
        let _ = FrameRgn(dc, edge, amber, 2, 2);
        let font = |height: f32, weight: windows::Win32::Graphics::Gdi::FONT_WEIGHT| {
            CreateFontW(
                -((height * s) as i32),
                0,
                0,
                0,
                weight.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                Default::default(),
                CLEARTYPE_QUALITY,
                0,
                w!("Segoe UI"),
            )
        };
        let bold = font(15.0, FW_SEMIBOLD);
        let small = font(13.0, FW_NORMAL);
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, COLORREF(0x00FF_FFFF));
        let old = SelectObject(dc, bold.into());
        let pad = (12.0 * s) as i32;
        let mut line = RECT {
            left: pad,
            top: (6.0 * s) as i32,
            right: w - pad,
            bottom: h / 2,
        };
        let mut text: Vec<u16> = chip.text.to_string().encode_utf16().collect();
        DrawTextW(
            dc,
            &mut text,
            &mut line,
            DT_LEFT | DT_VCENTER | DT_SINGLELINE,
        );
        SelectObject(dc, small.into());
        let button_brush = CreateSolidBrush(COLORREF(0x0045_3A44));
        for (rect, (label, _)) in buttons(w, h, s).iter().zip(BUTTONS) {
            FillRect(dc, rect, button_brush);
            let mut r = *rect;
            let mut label: Vec<u16> = label.encode_utf16().collect();
            DrawTextW(
                dc,
                &mut label,
                &mut r,
                DT_CENTER | DT_VCENTER | DT_SINGLELINE,
            );
        }
        SelectObject(dc, old);
        let _ = DeleteObject(bold.into());
        let _ = DeleteObject(small.into());
        let _ = DeleteObject(background.into());
        let _ = DeleteObject(amber.into());
        let _ = DeleteObject(button_brush.into());
        let _ = DeleteObject(edge.into());
        let _ = EndPaint(hwnd, &ps);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const M: ScreenRect = ScreenRect {
        left: -1920,
        top: 0,
        right: 0,
        bottom: 1080,
    };

    #[test]
    fn the_chip_is_never_over_the_control_or_the_cursor() {
        // Heading for a Send button near the bottom right of a monitor left of the primary.
        let send = ScreenRect {
            left: -140,
            top: 1020,
            right: -60,
            bottom: 1050,
        };
        for scale in [1.0, 1.5, 2.0] {
            let chip = place((-100, 1035), Some(send), M, scale);
            assert!(!intersects(chip, send), "{scale}: {chip:?}");
            assert!(!chip.contains(-100, 1035));
            assert!(chip.left >= M.left && chip.right <= M.right && chip.bottom <= M.bottom);
        }
    }

    #[test]
    fn three_buttons_side_by_side_in_the_lower_half() {
        let b = buttons(380, 76, 1.0);
        assert!(b.windows(2).all(|p| p[0].right < p[1].left));
        assert!(b.iter().all(|r| r.top >= 38 && r.bottom <= 76));
    }
}
