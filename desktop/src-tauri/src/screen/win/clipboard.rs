//! Reading the clipboard's text, only when the student presses "Pin copied link" on the island's
//! music panel (the island never takes the focus, so it can't be pasted into). Never read
//! otherwise, never kept: the caller looks for a Spotify link in it and drops the rest.

use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::CF_UNICODETEXT;

/// The clipboard's text, cut to at most `max_units` UTF-16 units; None if there's no text or
/// another app has the clipboard open.
pub fn text(max_units: usize) -> Option<String> {
    let format = u32::from(CF_UNICODETEXT.0);
    // SAFETY: the clipboard is opened (for no window), read and closed again on this thread; the
    // data handle belongs to the clipboard and is only read while it's open and locked.
    unsafe {
        IsClipboardFormatAvailable(format).ok()?;
        OpenClipboard(None).ok()?;
        let text = read_locked(format, max_units);
        let _ = CloseClipboard();
        text
    }
}

/// SAFETY: the clipboard must be open on this thread.
unsafe fn read_locked(format: u32, max_units: usize) -> Option<String> {
    let handle = GetClipboardData(format).ok()?;
    let global = HGLOBAL(handle.0);
    let units = GlobalSize(global) / 2;
    let data = GlobalLock(global).cast::<u16>();
    if data.is_null() {
        return None;
    }
    // SAFETY: the locked block holds `units` UTF-16 units; it stays locked until GlobalUnlock.
    let all = std::slice::from_raw_parts(data, units);
    let end = all.iter().position(|&unit| unit == 0).unwrap_or(all.len());
    let text = String::from_utf16_lossy(&all[..end.min(max_units)]);
    let _ = GlobalUnlock(global);
    Some(text)
}
