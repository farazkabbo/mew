//! A real non-activating NSPanel hosts the Tauri view. The original hidden Tauri window keeps
//! its navigation/IPC identity; AppKit owns activation, geometry and click handling separately.
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use objc2::{define_class, msg_send, rc::Retained, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSBackingStoreType, NSColor, NSPanel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_foundation::NSObjectProtocol;
use tauri::{Runtime, WebviewWindow};

#[derive(Default)]
struct PanelState {
    keyboard: Cell<bool>,
}

define_class!(
    #[unsafe(super(NSPanel))]
    #[name = "NebNonactivatingOverlayPanel"]
    #[thread_kind = MainThreadOnly]
    #[ivars = PanelState]
    struct OverlayPanel;
    unsafe impl NSObjectProtocol for OverlayPanel {}
    impl OverlayPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool { self.ivars().keyboard.get() }
        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main_window(&self) -> bool { false }
    }
);

thread_local! {
    // AppKit objects stay on the main thread; clones are retained only during native actions.
    static PANELS: RefCell<HashMap<String, Retained<OverlayPanel>>> = RefCell::new(HashMap::new());
}

/// Main-thread only. Move the existing content view, not its JS/IPC/nav configuration, into a
/// native panel created with the non-activating style at initialization (never by class swizzling).
pub fn attach<R: Runtime>(window: &WebviewWindow<R>, keyboard: bool) -> tauri::Result<()> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| std::io::Error::other("Panel requires main thread"))?;
    let existing = unsafe { &*(window.ns_window()? as *const NSWindow) };
    let content = existing
        .contentView()
        .ok_or_else(|| std::io::Error::other("Overlay has no content view"))?;
    let allocated = OverlayPanel::alloc(mtm).set_ivars(PanelState {
        keyboard: Cell::new(keyboard),
    });
    // SAFETY: signature matches NSWindow's designated initializer. NSPanel is initialized
    // with NonactivatingPanel from the beginning, and all AppKit calls are on the main thread.
    let panel: Retained<OverlayPanel> = unsafe {
        msg_send![super(allocated),
            initWithContentRect: content.frame(),
            styleMask: NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
            backing: NSBackingStoreType::Buffered,
            defer: false
        ]
    };
    panel.setTitle(&existing.title());
    panel.setFloatingPanel(true);
    panel.setBecomesKeyOnlyIfNeeded(true);
    panel.setHidesOnDeactivate(false);
    panel.setExcludedFromWindowsMenu(true);
    panel.setLevel(25); // NSStatusWindowLevel: below system alerts and security panels.
    panel.setOpaque(false);
    panel.setBackgroundColor(Some(&NSColor::clearColor()));
    panel.setHasShadow(false);
    panel.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    existing.setContentView(None);
    panel.setContentView(Some(&content));
    PANELS.with(|panels| {
        panels.borrow_mut().insert(window.label().into(), panel);
    });
    Ok(())
}

fn get(label: &str) -> Option<Retained<OverlayPanel>> {
    MainThreadMarker::new()?;
    PANELS.with(|panels| panels.borrow().get(label).cloned())
}

pub fn keyboard(label: &str, enabled: bool) {
    if let Some(panel) = get(label) {
        panel.ivars().keyboard.set(enabled);
    }
}

pub fn with_window<R: Runtime>(window: &WebviewWindow<R>, action: impl FnOnce(&NSWindow)) {
    if MainThreadMarker::new().is_none() {
        return;
    }
    if let Some(panel) = get(window.label()) {
        action(&panel);
    } else if let Ok(raw) = window.ns_window() {
        // SAFETY: Tauri's owning handle is alive and borrowed synchronously on the main thread.
        action(unsafe { &*(raw as *const NSWindow) });
    }
}
