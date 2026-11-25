//! What can be clicked in the window in front (docs/CURSOR_MODES.md, B), from UI Automation.
//!
//! One thread keeps the foreground window's invokable controls (Invoke, Toggle, SelectionItem
//! and ExpandCollapse patterns) with their names, control types, automation ids and rectangles,
//! collected in one cached round trip. It refreshes on events, never by polling:
//! - UI Automation's focus-changed and structure-changed events (the window's subtree);
//! - WinEvents for the window in front changing, it moving or resizing, and scrolling ending.
//!
//! Events only mark the set stale; it's collected again 120 ms after the last one (a menu
//! opening sends dozens). Blocked apps and Neb's own windows give an empty set. Names stay in
//! memory, replaced by the next collection; they're never logged or saved.

use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use windows::core::implement;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    SAFEARRAY,
};
use windows::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCacheRequest, IUIAutomationCondition,
    IUIAutomationElement, IUIAutomationFocusChangedEventHandler,
    IUIAutomationFocusChangedEventHandler_Impl, IUIAutomationStructureChangedEventHandler,
    IUIAutomationStructureChangedEventHandler_Impl, SetWinEventHook, StructureChangeType,
    TreeScope_Descendants, TreeScope_Subtree, UIA_AutomationIdPropertyId,
    UIA_BoundingRectanglePropertyId, UIA_ControlTypePropertyId,
    UIA_IsExpandCollapsePatternAvailablePropertyId, UIA_IsInvokePatternAvailablePropertyId,
    UIA_IsOffscreenPropertyId, UIA_IsSelectionItemPatternAvailablePropertyId,
    UIA_IsTogglePatternAvailablePropertyId, UIA_NamePropertyId, UnhookWinEvent, HWINEVENTHOOK,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetClassNameW, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
    KillTimer, PostThreadMessageW, SetTimer, TranslateMessage, EVENT_OBJECT_LOCATIONCHANGE,
    EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_SCROLLINGEND, MSG, OBJID_WINDOW, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS, WM_APP, WM_QUIT, WM_TIMER,
};

use super::target::{exe_name_of, window_title};
use crate::screen::cursor::target::{control_type_name, Source, Target, TargetSet};
use crate::screen::frame::ScreenRect;

/// The most controls kept for one window (a long web page has thousands).
const MAX_TARGETS: i32 = 600;
const DEBOUNCE_MS: u32 = 120;
const WM_STALE: u32 = WM_APP + 41;
const WM_REFRESH_NOW: u32 = WM_APP + 42;

/// Decides whether an app may be read at all (blocked apps: false).
pub type AppFilter = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// The latest set and a counter that moves on every collection.
#[derive(Clone)]
pub struct Targets {
    latest: Arc<Mutex<Arc<TargetSet>>>,
    generation: Arc<AtomicU64>,
}

impl Targets {
    pub fn latest(&self) -> Arc<TargetSet> {
        Arc::clone(&self.latest.lock().unwrap_or_else(|p| p.into_inner()))
    }
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
}

/// The running watcher; dropping it unhooks everything and ends the thread.
pub struct TargetWatcher {
    thread_id: u32,
    targets: Targets,
}

impl TargetWatcher {
    pub fn start(allowed: AppFilter) -> Option<Self> {
        let targets = Targets {
            latest: Arc::new(Mutex::new(Arc::new(TargetSet::default()))),
            generation: Arc::new(AtomicU64::new(0)),
        };
        let for_thread = targets.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("mew-cursor-targets".into())
            .spawn(move || {
                // SAFETY: COM for this thread; balanced below.
                let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
                // SAFETY: no arguments.
                let thread_id = unsafe { GetCurrentThreadId() };
                match Watch::new(thread_id, for_thread, allowed) {
                    Some(mut watch) => {
                        let _ = sender.send(Some(thread_id));
                        watch.collect();
                        watch.run();
                    }
                    None => {
                        let _ = sender.send(None);
                    }
                }
                if com {
                    // SAFETY: balances the successful CoInitializeEx above.
                    unsafe { CoUninitialize() };
                }
            })
            .ok()?;
        let thread_id = receiver.recv().ok()??;
        Some(Self { thread_id, targets })
    }

    pub fn targets(&self) -> Targets {
        self.targets.clone()
    }

    /// Collect again now (after Neb itself changed something, or a click).
    pub fn refresh_now(&self) {
        // SAFETY: posting to a thread id we started.
        let _ = unsafe { PostThreadMessageW(self.thread_id, WM_REFRESH_NOW, WPARAM(0), LPARAM(0)) };
    }
}

impl Drop for TargetWatcher {
    fn drop(&mut self) {
        // SAFETY: as above; harmless if the thread already ended.
        let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
    }
}

thread_local! {
    /// The window in front, for the WinEvent callback to filter location changes.
    static FRONT: RefCell<isize> = const { RefCell::new(0) };
    static THREAD: RefCell<u32> = const { RefCell::new(0) };
}

#[implement(
    IUIAutomationFocusChangedEventHandler,
    IUIAutomationStructureChangedEventHandler
)]
struct Notify {
    thread_id: u32,
}

impl Notify {
    fn stale(&self) {
        // SAFETY: posting to the watcher thread; UIA calls this on its own threads, so nothing
        // else happens here (UI Automation calls from inside a handler can deadlock).
        let _ = unsafe { PostThreadMessageW(self.thread_id, WM_STALE, WPARAM(0), LPARAM(0)) };
    }
}

impl IUIAutomationFocusChangedEventHandler_Impl for Notify_Impl {
    fn HandleFocusChangedEvent(
        &self,
        _sender: windows::core::Ref<IUIAutomationElement>,
    ) -> windows::core::Result<()> {
        self.stale();
        Ok(())
    }
}

impl IUIAutomationStructureChangedEventHandler_Impl for Notify_Impl {
    fn HandleStructureChangedEvent(
        &self,
        _sender: windows::core::Ref<IUIAutomationElement>,
        _change: StructureChangeType,
        _runtime_id: *const SAFEARRAY,
    ) -> windows::core::Result<()> {
        self.stale();
        Ok(())
    }
}

struct Watch {
    client: IUIAutomation,
    cache: IUIAutomationCacheRequest,
    condition: IUIAutomationCondition,
    focus_handler: IUIAutomationFocusChangedEventHandler,
    structure_handler: IUIAutomationStructureChangedEventHandler,
    /// The root the structure handler is on.
    watched: Option<IUIAutomationElement>,
    win_events: Vec<HWINEVENTHOOK>,
    targets: Targets,
    allowed: AppFilter,
    timer: usize,
    own_pid: u32,
}

impl Watch {
    fn new(thread_id: u32, targets: Targets, allowed: AppFilter) -> Option<Self> {
        THREAD.with(|t| *t.borrow_mut() = thread_id);
        // SAFETY: in-process COM activation and plain COM calls on a thread with COM initialised;
        // every interface is released when dropped.
        unsafe {
            let client: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let cache = client.CreateCacheRequest().ok()?;
            for property in [
                UIA_NamePropertyId,
                UIA_ControlTypePropertyId,
                UIA_AutomationIdPropertyId,
                UIA_BoundingRectanglePropertyId,
            ] {
                cache.AddProperty(property).ok()?;
            }
            let yes = VARIANT::from(true);
            let pattern = |id| client.CreatePropertyCondition(id, &yes);
            let invokable = client
                .CreateOrCondition(
                    &client
                        .CreateOrCondition(
                            &pattern(UIA_IsInvokePatternAvailablePropertyId).ok()?,
                            &pattern(UIA_IsTogglePatternAvailablePropertyId).ok()?,
                        )
                        .ok()?,
                    &client
                        .CreateOrCondition(
                            &pattern(UIA_IsSelectionItemPatternAvailablePropertyId).ok()?,
                            &pattern(UIA_IsExpandCollapsePatternAvailablePropertyId).ok()?,
                        )
                        .ok()?,
                )
                .ok()?;
            let on_screen = client
                .CreatePropertyCondition(UIA_IsOffscreenPropertyId, &VARIANT::from(false))
                .ok()?;
            let condition = client.CreateAndCondition(&invokable, &on_screen).ok()?;
            let notify = Notify { thread_id };
            let focus_handler: IUIAutomationFocusChangedEventHandler = notify.into();
            let structure_handler: IUIAutomationStructureChangedEventHandler =
                windows::core::Interface::cast(&focus_handler).ok()?;
            client
                .AddFocusChangedEventHandler(None, &focus_handler)
                .ok()?;
            let hook = |event| {
                let handle = SetWinEventHook(
                    event,
                    event,
                    None,
                    Some(on_win_event),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                );
                (!handle.is_invalid()).then_some(handle)
            };
            let win_events = [
                EVENT_SYSTEM_FOREGROUND,
                EVENT_OBJECT_LOCATIONCHANGE,
                EVENT_SYSTEM_SCROLLINGEND,
            ]
            .into_iter()
            .filter_map(hook)
            .collect();
            Some(Self {
                client,
                cache,
                condition,
                focus_handler,
                structure_handler,
                watched: None,
                win_events,
                targets,
                allowed,
                timer: 0,
                own_pid: GetCurrentProcessId(),
            })
        }
    }

    fn run(&mut self) {
        let mut msg = MSG::default();
        // SAFETY: the standard message loop of a thread we own.
        unsafe {
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                match msg.message {
                    WM_STALE => {
                        // Restart the quiet period.
                        if self.timer != 0 {
                            let _ = KillTimer(None, self.timer);
                        }
                        self.timer = SetTimer(None, 0, DEBOUNCE_MS, None);
                    }
                    WM_REFRESH_NOW => self.collect(),
                    WM_TIMER if msg.wParam.0 == self.timer => {
                        let _ = KillTimer(None, self.timer);
                        self.timer = 0;
                        self.collect();
                    }
                    _ => {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
            }
        }
    }

    /// Collects the foreground window's targets and publishes them.
    fn collect(&mut self) {
        // SAFETY: no arguments.
        let front = unsafe { GetForegroundWindow() };
        FRONT.with(|f| *f.borrow_mut() = front.0 as isize);
        let set = self.read(front).unwrap_or_default();
        *self
            .targets
            .latest
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Arc::new(set);
        self.targets.generation.fetch_add(1, Ordering::SeqCst);
    }

    fn read(&mut self, front: HWND) -> Option<TargetSet> {
        if front.is_invalid() {
            return None;
        }
        let mut pid = 0u32;
        // SAFETY: valid out pointer.
        unsafe { GetWindowThreadProcessId(front, Some(&mut pid)) };
        if pid == 0 || pid == self.own_pid {
            return None;
        }
        let process = exe_name_of(front).unwrap_or_default();
        if process.is_empty() || !(self.allowed)(&process) {
            self.unwatch();
            return Some(TargetSet {
                window: front.0 as isize,
                process,
                ..TargetSet::default()
            });
        }
        // SAFETY: plain COM calls with interfaces built in `new`; Windows validates the handle.
        let root = unsafe { self.client.ElementFromHandle(front) }.ok()?;
        self.watch(&root);
        // SAFETY: as above.
        let found =
            unsafe { root.FindAllBuildCache(TreeScope_Descendants, &self.condition, &self.cache) }
                .ok()?;
        // SAFETY: as above.
        let count = unsafe { found.Length() }.unwrap_or(0).min(MAX_TARGETS);
        let mut targets = Vec::with_capacity(count as usize);
        for i in 0..count {
            // SAFETY: index within Length.
            let Ok(element) = (unsafe { found.GetElement(i) }) else {
                continue;
            };
            // SAFETY: cached properties requested in `new`.
            let (rect, ty, name, id) = unsafe {
                (
                    element.CachedBoundingRectangle(),
                    element.CachedControlType(),
                    element.CachedName(),
                    element.CachedAutomationId(),
                )
            };
            let Ok(rect) = rect else { continue };
            if rect.right - rect.left < 2 || rect.bottom - rect.top < 2 {
                continue;
            }
            targets.push(Target {
                id: targets.len() as u32,
                name: name.map(|s| s.to_string()).unwrap_or_default(),
                control_type: control_type_name(ty.map(|t| t.0).unwrap_or(0)).to_owned(),
                automation_id: id.map(|s| s.to_string()).unwrap_or_default(),
                rect: ScreenRect {
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                },
                source: Source::Uia,
            });
        }
        Some(TargetSet {
            window: front.0 as isize,
            process,
            class: class_of(front),
            title: window_title(front),
            targets,
        })
    }

    /// Moves the structure handler to `root` if it's a new window.
    fn watch(&mut self, root: &IUIAutomationElement) {
        // SAFETY: plain COM calls on live interfaces.
        unsafe {
            if let Some(old) = &self.watched {
                if self
                    .client
                    .CompareElements(old, root)
                    .is_ok_and(|same| same.as_bool())
                {
                    return;
                }
            }
            self.unwatch();
            if self
                .client
                .AddStructureChangedEventHandler(
                    root,
                    TreeScope_Subtree,
                    None,
                    &self.structure_handler,
                )
                .is_ok()
            {
                self.watched = Some(root.clone());
            }
        }
    }

    fn unwatch(&mut self) {
        if let Some(old) = self.watched.take() {
            // SAFETY: removes the handler added in `watch` for this element.
            let _ = unsafe {
                self.client
                    .RemoveStructureChangedEventHandler(&old, &self.structure_handler)
            };
        }
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.unwatch();
        // SAFETY: removes what `new` added, on the thread that added it.
        unsafe {
            let _ = self
                .client
                .RemoveFocusChangedEventHandler(&self.focus_handler);
            for hook in self.win_events.drain(..) {
                let _ = UnhookWinEvent(hook);
            }
            if self.timer != 0 {
                let _ = KillTimer(None, self.timer);
            }
        }
    }
}

pub fn class_of(hwnd: HWND) -> String {
    let mut buffer = [0u16; 128];
    // SAFETY: the buffer is valid for its length.
    let n = unsafe { GetClassNameW(hwnd, &mut buffer) };
    String::from_utf16_lossy(&buffer[..n.max(0) as usize])
}

unsafe extern "system" fn on_win_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object: i32,
    _child: i32,
    _thread: u32,
    _time: u32,
) {
    let stale = match event {
        EVENT_SYSTEM_FOREGROUND | EVENT_SYSTEM_SCROLLINGEND => true,
        // Only the window in front itself moving or resizing (not every caret and tooltip).
        EVENT_OBJECT_LOCATIONCHANGE => {
            object == OBJID_WINDOW.0 && FRONT.with(|f| *f.borrow() == hwnd.0 as isize)
        }
        _ => false,
    };
    if stale {
        let thread = THREAD.with(|t| *t.borrow());
        // SAFETY: posting to our own thread.
        let _ = unsafe { PostThreadMessageW(thread, WM_STALE, WPARAM(0), LPARAM(0)) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live smoke test on this desktop (ignored by default: it reads whatever window is in
    /// front). It asserts only that the watcher, the hook and the layer start and stop, and
    /// prints counts, never names.
    #[test]
    #[ignore]
    fn watcher_hook_and_layer_start_and_stop_on_a_real_desktop() {
        let started = std::time::Instant::now();
        let watcher = TargetWatcher::start(Arc::new(|_: &str| true)).expect("watcher");
        let targets = watcher.targets();
        while targets.generation() == 0 && started.elapsed().as_secs() < 5 {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let set = targets.latest();
        println!(
            "collected {} targets in {:?} (process known: {})",
            set.targets.len(),
            started.elapsed(),
            !set.process.is_empty()
        );
        assert!(targets.generation() >= 1);
        let hook = super::super::mouse_stream::MouseStream::start().expect("hook");
        let mut events = Vec::new();
        std::thread::sleep(std::time::Duration::from_millis(100));
        hook.drain(&mut events);
        drop(hook);
        let layer = super::super::cursor_layer::CursorLayer::start(false).expect("layer");
        layer.clear();
        drop(layer);
        drop(watcher);
    }
}
