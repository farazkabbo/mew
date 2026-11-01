//! Where a tablet's pen is. Windows hides the mouse cursor and stops moving its position while a
//! Windows Ink pen hovers, so the pointer beside the cursor would stand still. Raw Input is the one
//! way to hear a pen over every app without a hook.
//!
//! Only pens and digitizers are registered: no keyboard, no mouse, no touch screen or touchpad. Only the position is read, kept in
//! memory for the pointer to follow, replaced by the next one, and never saved or sent. Reports are
//! dropped while the pointer isn't running (`set_active`).
//!
//! A pen's report says where it is across the digitizer's range; that range is taken to cover the
//! monitor the mouse position is on. A tablet mapped to part of a screen would need more.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, Once};

use windows::core::w;
use windows::Win32::Devices::HumanInterfaceDevice::{
    HidP_GetSpecificValueCaps, HidP_GetUsageValue, HidP_Input, HIDP_VALUE_CAPS,
    PHIDP_PREPARSED_DATA,
};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::{
    GetRawInputData, GetRawInputDeviceInfoW, RegisterRawInputDevices, HRAWINPUT, RAWINPUT,
    RAWINPUTDEVICE, RAWINPUTHEADER, RIDEV_INPUTSINK, RIDI_PREPARSEDDATA, RID_INPUT, RIM_TYPEHID,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassExW, HWND_MESSAGE,
    MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_INPUT, WNDCLASSEXW,
};

use super::{input, target};
use crate::screen::frame::ScreenRect;
use crate::screen::pointer::PenSeen;

const DIGITIZER_PAGE: u16 = 0x0D;
const DIGITIZER_USAGE: u16 = 0x01;
const PEN_USAGE: u16 = 0x02;
const DESKTOP_PAGE: u16 = 0x01;
const X_USAGE: u16 = 0x30;
const Y_USAGE: u16 = 0x31;

static ACTIVE: AtomicBool = AtomicBool::new(false);
static LATEST: Mutex<Option<PenSeen>> = Mutex::new(None);
static START: Once = Once::new();

/// Starts listening, once, on a thread of its own.
pub fn start() {
    START.call_once(|| {
        let started = std::thread::Builder::new()
            .name("neb-pen".into())
            .spawn(|| {
                if let Err(error) = run() {
                    eprintln!("[screen] can't follow a pen ({:#x})", error.code().0);
                }
            });
        if started.is_err() {
            eprintln!("[screen] can't follow a pen");
        }
    });
}

/// Whether reports are used; off, they're dropped and the last position is forgotten.
pub fn set_active(active: bool) {
    ACTIVE.store(active, Ordering::SeqCst);
    if !active {
        *latest_slot() = None;
    }
}

/// Where the pen was last heard, and the mouse position then.
pub fn latest() -> Option<PenSeen> {
    *latest_slot()
}

fn latest_slot() -> std::sync::MutexGuard<'static, Option<PenSeen>> {
    LATEST
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A digitizer value across `[min, max]` as a pixel across `[start, end)`.
fn scaled(value: i32, min: i32, max: i32, start: i32, end: i32) -> Option<i32> {
    if max <= min || end <= start {
        return None;
    }
    let share = (f64::from(value.clamp(min, max)) - f64::from(min)) / f64::from(max - min);
    Some((f64::from(start) + share * f64::from(end - start - 1)).round() as i32)
}

/// Where a report's values put the pen on `monitor`.
fn on_monitor(x: (i32, i32, i32), y: (i32, i32, i32), monitor: ScreenRect) -> Option<(i32, i32)> {
    Some((
        scaled(x.0, x.1, x.2, monitor.left, monitor.right)?,
        scaled(y.0, y.1, y.2, monitor.top, monitor.bottom)?,
    ))
}

/// What's kept about a pen device: how to read its reports, and its X and Y ranges.
struct Device {
    preparsed: Vec<u8>,
    x: (i32, i32),
    y: (i32, i32),
}

impl Device {
    fn read(handle: HANDLE) -> Option<Device> {
        let mut size = 0_u32;
        // SAFETY: asks for the size only (no buffer).
        unsafe { GetRawInputDeviceInfoW(Some(handle), RIDI_PREPARSEDDATA, None, &raw mut size) };
        if size == 0 {
            return None;
        }
        let mut preparsed = vec![0_u8; size as usize];
        // SAFETY: the buffer holds `size` bytes, as Windows just said it needs.
        let read = unsafe {
            GetRawInputDeviceInfoW(
                Some(handle),
                RIDI_PREPARSEDDATA,
                Some(preparsed.as_mut_ptr().cast()),
                &raw mut size,
            )
        };
        if read == u32::MAX {
            return None;
        }
        let x = Self::range(&preparsed, X_USAGE)?;
        let y = Self::range(&preparsed, Y_USAGE)?;
        Some(Device { preparsed, x, y })
    }

    fn data(preparsed: &[u8]) -> PHIDP_PREPARSED_DATA {
        PHIDP_PREPARSED_DATA(preparsed.as_ptr() as isize)
    }

    fn range(preparsed: &[u8], usage: u16) -> Option<(i32, i32)> {
        // A digitizer can repeat X and Y for each contact: they share a range.
        let mut caps = [HIDP_VALUE_CAPS::default(); 16];
        let mut count = caps.len() as u16;
        // SAFETY: `preparsed` is this device's data, alive for the call; `count` caps fit the buffer.
        let status = unsafe {
            HidP_GetSpecificValueCaps(
                HidP_Input,
                Some(DESKTOP_PAGE),
                Some(0),
                Some(usage),
                caps.as_mut_ptr(),
                &raw mut count,
                Self::data(preparsed),
            )
        };
        (status.is_ok() && count > 0).then(|| (caps[0].LogicalMin, caps[0].LogicalMax))
    }

    fn value(&self, usage: u16, report: &mut [u8]) -> Option<i32> {
        let mut value = 0_u32;
        // SAFETY: `preparsed` is this device's data and `report` one whole report from it.
        let status = unsafe {
            HidP_GetUsageValue(
                HidP_Input,
                DESKTOP_PAGE,
                None,
                usage,
                &raw mut value,
                Self::data(&self.preparsed),
                report,
            )
        };
        status.is_ok().then_some(value as i32)
    }
}

thread_local! {
    static DEVICES: std::cell::RefCell<HashMap<isize, Option<Device>>> =
        std::cell::RefCell::new(HashMap::new());
}

fn run() -> windows::core::Result<()> {
    // SAFETY: GetModuleHandleW(None) returns this executable's module.
    let instance = unsafe { GetModuleHandleW(None) }?;
    let class = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(window_proc),
        hInstance: instance.into(),
        lpszClassName: w!("NebPenInput"),
        ..Default::default()
    };
    // SAFETY: the class name is static, its procedure valid; this runs once.
    unsafe { RegisterClassExW(&raw const class) };
    // SAFETY: a message-only window of this thread, which lives as long as the app.
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("NebPenInput"),
            w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance.into()),
            None,
        )
    }?;
    // Both: some tablet drivers (XP-Pen's) take the pen for themselves and pass it on through a
    // virtual digitizer, which reports as a plain digitizer rather than a pen.
    let devices = [DIGITIZER_USAGE, PEN_USAGE].map(|usage| RAWINPUTDEVICE {
        usUsagePage: DIGITIZER_PAGE,
        usUsage: usage,
        dwFlags: RIDEV_INPUTSINK,
        hwndTarget: hwnd,
    });
    // SAFETY: correctly sized entries, for the window just made.
    unsafe { RegisterRawInputDevices(&devices, std::mem::size_of::<RAWINPUTDEVICE>() as u32) }?;
    eprintln!("[screen] listening for a tablet's pen");
    let mut message = MSG::default();
    // SAFETY: the standard message loop for this thread's window.
    unsafe {
        while GetMessageW(&raw mut message, None, 0, 0).as_bool() {
            DispatchMessageW(&raw const message);
        }
    }
    Ok(())
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_INPUT && ACTIVE.load(Ordering::SeqCst) {
        on_report(HRAWINPUT(lparam.0 as *mut _));
    }
    // SAFETY: default handling for our own window (WM_INPUT needs it to clean up).
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

fn on_report(input: HRAWINPUT) {
    let header = std::mem::size_of::<RAWINPUTHEADER>() as u32;
    let mut size = 0_u32;
    // SAFETY: asks for the size only (no buffer).
    unsafe { GetRawInputData(input, RID_INPUT, None, &raw mut size, header) };
    let offset = std::mem::offset_of!(RAWINPUT, data)
        + std::mem::offset_of!(windows::Win32::UI::Input::RAWHID, bRawData);
    // A short HID report makes this smaller than a RAWINPUT, whose size is set by its largest kind.
    if (size as usize) < offset {
        return;
    }
    // u64s: aligned for RAWINPUT, and never shorter than one, whatever came.
    let room = (size as usize).max(std::mem::size_of::<RAWINPUT>());
    let mut buffer = vec![0_u64; room.div_ceil(8)];
    // SAFETY: the buffer holds `size` bytes, as Windows just said it needs.
    let read = unsafe {
        GetRawInputData(
            input,
            RID_INPUT,
            Some(buffer.as_mut_ptr().cast()),
            &raw mut size,
            header,
        )
    };
    if read != size {
        return;
    }
    // SAFETY: Windows filled the buffer with one RAWINPUT, and it's aligned for it.
    let raw = unsafe { &*buffer.as_ptr().cast::<RAWINPUT>() };
    if raw.header.dwType != RIM_TYPEHID.0 {
        return;
    }
    // SAFETY: the type says this is the `hid` variant.
    let hid = unsafe { &raw.data.hid };
    let (each, count) = (hid.dwSizeHid as usize, hid.dwCount as usize);
    let device = raw.header.hDevice;
    let total = each.saturating_mul(count);
    if each == 0 || count == 0 || offset.saturating_add(total) > size as usize {
        return;
    }
    // SAFETY: the bytes after `offset` are this report's, checked to lie inside the buffer.
    let reports = unsafe {
        std::slice::from_raw_parts_mut(buffer.as_mut_ptr().cast::<u8>().add(offset), total)
    };
    // The newest report is the one that matters.
    let Some(last) = reports.chunks_exact_mut(each).last() else {
        return;
    };
    let values = DEVICES.with(|devices| {
        let mut devices = devices.borrow_mut();
        let known = devices
            .entry(device.0 as isize)
            .or_insert_with(|| Device::read(device));
        let known = known.as_ref()?;
        Some((
            (known.value(X_USAGE, last)?, known.x.0, known.x.1),
            (known.value(Y_USAGE, last)?, known.y.0, known.y.1),
        ))
    });
    let Some((x, y)) = values else {
        return;
    };
    let cursor = input::cursor();
    let Some((monitor, _)) = cursor.and_then(|(cx, cy)| target::monitor_at(cx, cy)) else {
        return;
    };
    if let Some(at) = on_monitor(x, y, monitor) {
        let mut slot = latest_slot();
        if slot.is_none() {
            eprintln!("[screen] the pointer is following the pen");
        }
        *slot = Some(PenSeen { at, cursor });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: ScreenRect = ScreenRect {
        left: -1920,
        top: 0,
        right: 0,
        bottom: 1080,
    };

    #[test]
    fn a_digitizer_range_covers_the_monitor() {
        let x = |v| (v, 0, 32767);
        let y = |v| (v, 0, 32767);
        assert_eq!(on_monitor(x(0), y(0), MONITOR), Some((-1920, 0)));
        assert_eq!(on_monitor(x(32767), y(32767), MONITOR), Some((-1, 1079)));
        assert_eq!(on_monitor(x(16384), y(16384), MONITOR), Some((-960, 540)));
    }

    #[test]
    fn a_value_past_the_range_stays_on_the_monitor_and_a_bad_range_is_refused() {
        assert_eq!(scaled(99_999, 0, 100, 0, 1920), Some(1919));
        assert_eq!(scaled(-5, 0, 100, 0, 1920), Some(0));
        assert_eq!(scaled(5, 100, 100, 0, 1920), None);
        assert_eq!(scaled(5, 0, 100, 10, 10), None);
    }
}
