//! Screen Coach's Windows code. Every `unsafe` Win32/WinRT call lives in a small function in
//! these modules, with its safety reasoning next to it.

pub mod capture;
pub mod encode;
pub mod indicator;
pub mod ocr;
pub mod system;
pub mod target;
#[cfg(test)]
pub mod test_window;
pub mod uia;

use windows::core::HSTRING;
use windows::Foundation::Metadata::ApiInformation;
use windows::Graphics::Capture::GraphicsCaptureSession;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::ErrorReporting::{WerSetFlags, WER_FAULT_REPORTING_FLAG_NOHEAP};

/// Why Screen Coach can't run on this PC, if it can't.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unsupported {
    /// Older than Windows 10 version 2004 (build 19041): no way to keep our overlay out of
    /// captures (WDA_EXCLUDEFROMCAPTURE), among others.
    WindowsTooOld,
    /// Windows.Graphics.Capture isn't available (e.g. no suitable graphics driver).
    CaptureUnavailable,
}

/// Checks the Windows features Screen Coach depends on.
pub fn check_support() -> Result<(), Unsupported> {
    // Universal API contract v10 shipped with Windows 10 version 2004 (build 19041); feature
    // detection is what Microsoft recommends over reading version numbers.
    let contract = HSTRING::from("Windows.Foundation.UniversalApiContract");
    if !ApiInformation::IsApiContractPresentByMajor(&contract, 10).unwrap_or(false) {
        return Err(Unsupported::WindowsTooOld);
    }
    if !GraphicsCaptureSession::IsSupported().unwrap_or(false) {
        return Err(Unsupported::CaptureUnavailable);
    }
    Ok(())
}

/// Keeps screen pixels out of crash reports: Windows Error Reporting then collects dumps
/// without the process heap, where captured frames live (brief §7.2, §7.9).
pub fn exclude_heap_from_crash_dumps() {
    // SAFETY: WerSetFlags only records a flag for this process; no pointers involved.
    if let Err(error) = unsafe { WerSetFlags(WER_FAULT_REPORTING_FLAG_NOHEAP) } {
        eprintln!("[screen] WerSetFlags failed ({:#x})", error.code().0);
    }
}

/// COM (multithreaded apartment) for the lifetime of a worker thread.
pub struct ComThread(());

impl ComThread {
    pub fn init() -> windows::core::Result<Self> {
        // SAFETY: called once at the start of a thread we own; balanced by Drop on the same thread.
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
        Ok(Self(()))
    }
}

impl Drop for ComThread {
    fn drop(&mut self) {
        // SAFETY: balances the successful CoInitializeEx in `init`, on the same thread
        // (ComThread is created and dropped inside one thread's closure).
        unsafe { CoUninitialize() };
    }
}
