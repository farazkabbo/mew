//! UI Automation: is a password field focused right now? (brief §7.3) And, for a clip the
//! student is saving, what does the browser's address bar say? (S3 §3.3)

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationValuePattern, TreeScope_Descendants,
    UIA_AutomationIdPropertyId, UIA_ClassNamePropertyId, UIA_ControlTypePropertyId,
    UIA_EditControlTypeId, UIA_ValuePatternId,
};

use crate::screen::privacy::Focus;

/// Chromium browsers' address bar (Chrome, Edge, Brave, Vivaldi, Opera) has this class name.
const CHROMIUM_OMNIBOX: &str = "OmniboxViewViews";
/// Firefox's address bar has this automation id.
const FIREFOX_URL_BAR: &str = "urlbar-input";

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

    /// The text in a browser window's address bar, if there is one we recognise. Only read when
    /// the student saves a clip; the caller trims it before it's shown or kept.
    pub fn address_bar(&self, window: HWND) -> Option<String> {
        // SAFETY: plain COM calls on a valid client with conditions built here; every returned
        // interface is released when dropped. Windows validates the window handle.
        unsafe {
            let root = self.client.ElementFromHandle(window).ok()?;
            let edit = self
                .client
                .CreatePropertyCondition(
                    UIA_ControlTypePropertyId,
                    &VARIANT::from(UIA_EditControlTypeId.0),
                )
                .ok()?;
            let chromium = self
                .client
                .CreatePropertyCondition(UIA_ClassNamePropertyId, &VARIANT::from(CHROMIUM_OMNIBOX))
                .ok()?;
            let firefox = self
                .client
                .CreatePropertyCondition(
                    UIA_AutomationIdPropertyId,
                    &VARIANT::from(FIREFOX_URL_BAR),
                )
                .ok()?;
            let either = self.client.CreateOrCondition(&chromium, &firefox).ok()?;
            let condition = self.client.CreateAndCondition(&edit, &either).ok()?;
            let bar = root.FindFirst(TreeScope_Descendants, &condition).ok()?;
            let value: IUIAutomationValuePattern =
                bar.GetCurrentPatternAs(UIA_ValuePatternId).ok()?;
            let text = value.CurrentValue().ok()?.to_string();
            (!text.trim().is_empty()).then_some(text)
        }
    }
}
