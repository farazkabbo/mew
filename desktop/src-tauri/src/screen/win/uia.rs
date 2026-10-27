//! UI Automation: is a password field focused right now? (brief §7.3) And, for a clip the
//! student is saving, what does the browser's address bar say? (S3 §3.3)

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationScrollPattern,
    IUIAutomationValuePattern, TreeScope_Descendants, TreeScope_Subtree,
    UIA_AutomationIdPropertyId, UIA_ClassNamePropertyId, UIA_ControlTypePropertyId,
    UIA_EditControlTypeId, UIA_IsScrollPatternAvailablePropertyId, UIA_ScrollPatternId,
    UIA_ValuePatternId,
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

    /// The scrollable view in `window` at screen point (`x`, `y`): the smallest element there
    /// that scrolls (a web page, a PDF, a document). The window is searched rather than the
    /// point, since Neb's draw overlay is on top of it. Only its scroll position is ever read.
    pub fn scroller_at(&self, window: HWND, x: i32, y: i32) -> Option<Scroller> {
        // SAFETY: plain COM calls on a valid client with a condition built here; interfaces
        // are released when dropped. Windows validates the window handle.
        unsafe {
            let root = self.client.ElementFromHandle(window).ok()?;
            let condition = self
                .client
                .CreatePropertyCondition(
                    UIA_IsScrollPatternAvailablePropertyId,
                    &VARIANT::from(true),
                )
                .ok()?;
            let all = root.FindAll(TreeScope_Subtree, &condition).ok()?;
            let mut best: Option<(i64, Scroller)> = None;
            for i in 0..all.Length().ok()?.min(500) {
                let Ok(element) = all.GetElement(i) else {
                    continue;
                };
                let Ok(rect) = element.CurrentBoundingRectangle() else {
                    continue;
                };
                let inside =
                    (rect.left..rect.right).contains(&x) && (rect.top..rect.bottom).contains(&y);
                if !inside {
                    continue;
                }
                let Ok(pattern) =
                    element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
                else {
                    continue;
                };
                let scrolls = pattern
                    .CurrentVerticallyScrollable()
                    .is_ok_and(|b| b.as_bool())
                    || pattern
                        .CurrentHorizontallyScrollable()
                        .is_ok_and(|b| b.as_bool());
                let area = i64::from(rect.right - rect.left) * i64::from(rect.bottom - rect.top);
                if scrolls && best.as_ref().is_none_or(|(a, _)| area < *a) {
                    best = Some((area, Scroller { element, pattern }));
                }
            }
            best.map(|(_, scroller)| scroller)
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

/// A view that scrolls, found under the student's pen notes (`Automation::scroller_at`).
pub struct Scroller {
    element: IUIAutomationElement,
    pattern: IUIAutomationScrollPattern,
}

impl Scroller {
    /// How far the view has scrolled (physical pixels, x then y), or None if it's gone.
    pub fn offset(&self) -> Option<(f64, f64)> {
        use crate::screen::island::scroll_offset;
        // SAFETY: plain COM calls on interfaces this struct owns.
        unsafe {
            let rect = self.element.CurrentBoundingRectangle().ok()?;
            let (w, h) = (
                f64::from(rect.right - rect.left),
                f64::from(rect.bottom - rect.top),
            );
            let x = scroll_offset(
                self.pattern.CurrentHorizontalScrollPercent().ok()?,
                self.pattern.CurrentHorizontalViewSize().ok()?,
                w,
            );
            let y = scroll_offset(
                self.pattern.CurrentVerticalScrollPercent().ok()?,
                self.pattern.CurrentVerticalViewSize().ok()?,
                h,
            );
            Some((x, y))
        }
    }
}
