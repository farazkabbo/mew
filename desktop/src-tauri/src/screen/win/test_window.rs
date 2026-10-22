//! A small window that tests draw and then capture, so tests never capture the user's screen.
//! It never takes keyboard focus (WS_EX_NOACTIVATE), so it can't steal the user's typing.

use std::cell::RefCell;
use std::time::{Duration, Instant};

use windows::core::w;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect,
    SelectObject, SetBkMode, SetTextColor, DT_LEFT, DT_NOPREFIX, DT_SINGLELINE, PAINTSTRUCT,
    TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

thread_local! {
    /// The lines the window on this thread paints.
    static LINES: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

const LINE_HEIGHT: i32 = 48;

/// A topmost test window showing `lines` in black on white; destroyed when dropped.
pub struct TestWindow {
    pub hwnd: HWND,
}

impl TestWindow {
    pub fn show(lines: &[&str], width: i32) -> Self {
        LINES.with(|cell| *cell.borrow_mut() = lines.iter().map(|l| (*l).to_owned()).collect());
        let height = LINE_HEIGHT * lines.len() as i32 + 40;
        // SAFETY: a plain test window on this thread; destroyed on drop on the same thread.
        let hwnd = unsafe {
            let instance = GetModuleHandleW(None).expect("module handle");
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(paint_lines),
                hInstance: instance.into(),
                lpszClassName: w!("MewScreenTestWindow"),
                ..Default::default()
            };
            RegisterClassExW(&class);
            CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                w!("MewScreenTestWindow"),
                w!("Mew test window"),
                WS_POPUP | WS_VISIBLE,
                120,
                120,
                width,
                height,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .expect("test window")
        };
        pump(400);
        Self { hwnd }
    }
}

impl Drop for TestWindow {
    fn drop(&mut self) {
        // SAFETY: the window was created by `show` on this thread.
        let _ = unsafe { DestroyWindow(self.hwnd) };
    }
}

/// Handles this thread's window messages for `ms` milliseconds.
pub fn pump(ms: u64) {
    let until = Instant::now() + Duration::from_millis(ms);
    let mut msg = MSG::default();
    while Instant::now() < until {
        // SAFETY: standard message pump on the thread that owns the window.
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

unsafe extern "system" fn paint_lines(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg != WM_PAINT {
        // SAFETY: default handling for everything else.
        return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
    }
    // SAFETY: standard WM_PAINT handling; every GDI object created here is freed here.
    unsafe {
        let mut paint = PAINTSTRUCT::default();
        let dc = BeginPaint(hwnd, &mut paint);
        let white = CreateSolidBrush(COLORREF(0x00FF_FFFF));
        FillRect(dc, &paint.rcPaint, white);
        let font = CreateFontW(
            -34,
            0,
            0,
            0,
            400,
            0,
            0,
            0,
            Default::default(),
            Default::default(),
            Default::default(),
            Default::default(),
            Default::default(),
            w!("Segoe UI"),
        );
        let previous = SelectObject(dc, font.into());
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, COLORREF(0));
        LINES.with(|cell| {
            for (i, line) in cell.borrow().iter().enumerate() {
                let mut text: Vec<u16> = line.encode_utf16().collect();
                let top = 20 + i as i32 * LINE_HEIGHT;
                let mut rect = RECT {
                    left: 24,
                    top,
                    right: 4000,
                    bottom: top + LINE_HEIGHT,
                };
                DrawTextW(
                    dc,
                    &mut text,
                    &mut rect,
                    DT_LEFT | DT_SINGLELINE | DT_NOPREFIX,
                );
            }
        });
        SelectObject(dc, previous);
        let _ = DeleteObject(font.into());
        let _ = DeleteObject(white.into());
        let _ = EndPaint(hwnd, &paint);
    }
    LRESULT(0)
}
