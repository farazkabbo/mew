//! UI Automation: is a password field focused right now? (brief §7.3)

use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

use crate::screen::privacy::Focus;

/// A UI Automation client, created once per worker thread (creation costs a few milliseconds).
pub struct Automation {
    client: IUIAutomation,
}

impl Automation {
    pub fn new() -> windows::core::Result<Self> {
        // SAFETY: standard in-process COM activation on a thread with COM initialised.
        let client = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }?;
        Ok(Self { client })
    }

    /// What has keyboard focus. `Unknown` when UI Automation can't tell us; callers treat that
    /// as "don't capture".
    pub fn focus(&self) -> Focus {
        // SAFETY: plain COM calls on a valid client; the element is released when dropped.
        let Ok(element) = (unsafe { self.client.GetFocusedElement() }) else {
            return Focus::Unknown;
        };
        // SAFETY: as above.
        match unsafe { element.CurrentIsPassword() } {
            Ok(is_password) if is_password.as_bool() => Focus::Password,
            Ok(_) => Focus::Ordinary,
            Err(_) => Focus::Unknown,
        }
    }
}
