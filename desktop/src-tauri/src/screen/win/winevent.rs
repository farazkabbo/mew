//! Watching the window ink is drawn on, only while the ink is visible (S3 §2.3, decision 9).
//!
//! One thread with its own message loop holds:
//! - WinEvent hooks: the app in front changing, the target window moving, resizing, scrolling
//!   (standard scrollbars), minimising or closing;
//! - a low-level mouse hook: wheel turns and left-button drags (browsers and PDF viewers scroll
//!   without telling WinEvents). It notes only the kind of event and, during a drag, how far
//!   the pointer moved; nothing is recorded or kept;
//! - a 50 ms timer polling `GetLastInputInfo`, to notice key presses without a keyboard hook.
//!
//! The first change is reported once, and the thread unhooks everything and ends.

use std::cell::RefCell;
use std::time::Instant;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetAncestor, GetMessageW, GetWindowThreadProcessId,
    KillTimer, PostThreadMessageW, SetTimer, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, CHILDID_SELF, EVENT_OBJECT_DESTROY, EVENT_OBJECT_LOCATIONCHANGE,
    EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_SCROLLINGSTART, GA_ROOT,
    HHOOK, MSG, MSLLHOOKSTRUCT, OBJID_WINDOW, WH_MOUSE_LL, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEMOVE,
    WM_MOUSEWHEEL, WM_QUIT, WM_TIMER,
};

use crate::screen::watch::{left_target, Change, KeyJudge, Mouse, MouseJudge};

const POLL_MS: u32 = 50;

/// A running watch; dropping it (or calling `stop`) ends the thread.
pub struct Watch {
    thread_id: u32,
}

impl Watch {
    pub fn stop(&self) {
        // SAFETY: posting a message to a thread id we started; harmless if it already ended.
        let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.stop();
    }
}

/// What the hook callbacks share (they all run on the watch thread, one at a time).
struct State {
    target: isize,
    on_change: Box<dyn FnMut(Change) + Send>,
    mouse: MouseJudge,
    keys: KeyJudge,
    mouse_since_poll: bool,
    done: bool,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

/// Starts watching `target` (a top-level window). `on_change` runs once, on the watch thread.
pub fn start(target: HWND, on_change: impl FnMut(Change) + Send + 'static) -> Option<Watch> {
    let target_raw = target.0 as isize;
    let (sender, receiver) = std::sync::mpsc::channel();
    let on_change: Box<dyn FnMut(Change) + Send> = Box::new(on_change);
    std::thread::Builder::new()
        .name("mew-ink-watch".into())
        .spawn(move || {
            // SAFETY: no arguments.
            let thread_id = unsafe { GetCurrentThreadId() };
            STATE.with(|state| {
                *state.borrow_mut() = Some(State {
                    target: target_raw,
                    on_change,
                    mouse: MouseJudge::default(),
                    keys: KeyJudge::default(),
                    mouse_since_poll: false,
                    done: false,
                });
            });
            let hooks = Hooks::install(HWND(target_raw as *mut _));
            let _ = sender.send(hooks.is_some().then_some(thread_id));
            if let Some(hooks) = hooks {
                pump();
                drop(hooks);
            }
            STATE.with(|state| state.borrow_mut().take());
        })
        .ok()?;
    let thread_id = receiver.recv().ok()??;
    Some(Watch { thread_id })
}

/// Every hook and the poll timer, removed when dropped (on the thread that installed them).
struct Hooks {
    events: Vec<HWINEVENTHOOK>,
    mouse: HHOOK,
    timer: usize,
}

impl Hooks {
    fn install(target: HWND) -> Option<Self> {
        let mut pid = 0u32;
        // SAFETY: `pid` is a valid out pointer.
        unsafe { GetWindowThreadProcessId(target, Some(&mut pid)) };
        if pid == 0 {
            return None;
        }
        let hook = |event: u32, process: u32, flags: u32| {
            // SAFETY: an out-of-context hook with a valid callback; removed in `Drop`.
            let handle = unsafe {
                SetWinEventHook(event, event, None, Some(on_win_event), process, 0, flags)
            };
            (!handle.is_invalid()).then_some(handle)
        };
        let events = [
            // Anywhere: the student switching to another app (not to ours).
            hook(
                EVENT_SYSTEM_FOREGROUND,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            ),
            // The target app only.
            hook(EVENT_OBJECT_LOCATIONCHANGE, pid, WINEVENT_OUTOFCONTEXT),
            hook(EVENT_SYSTEM_SCROLLINGSTART, pid, WINEVENT_OUTOFCONTEXT),
            hook(EVENT_SYSTEM_MINIMIZESTART, pid, WINEVENT_OUTOFCONTEXT),
            hook(EVENT_OBJECT_DESTROY, pid, WINEVENT_OUTOFCONTEXT),
        ];
        let events: Vec<HWINEVENTHOOK> = events.into_iter().flatten().collect();
        // SAFETY: a low-level hook needs no module for a callback in this process; it runs on
        // this thread's message loop and is removed in `Drop`.
        let mouse = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), None, 0) };
        // SAFETY: a thread timer (no window): WM_TIMER arrives in this thread's queue.
        let timer = unsafe { SetTimer(None, 0, POLL_MS, None) };
        match mouse {
            Ok(mouse) if events.len() == 5 && timer != 0 => Some(Self {
                events,
                mouse,
                timer,
            }),
            // Without every hook, ink could stay on screen after its content moved: don't watch
            // half-blind (the caller then doesn't show the ink at all).
            other => {
                if let Ok(mouse) = other {
                    // SAFETY: the hook was installed just above.
                    let _ = unsafe { UnhookWindowsHookEx(mouse) };
                }
                for event in events {
                    // SAFETY: installed just above.
                    let _ = unsafe { UnhookWinEvent(event) };
                }
                if timer != 0 {
                    // SAFETY: the timer was created just above on this thread.
                    let _ = unsafe { KillTimer(None, timer) };
                }
                None
            }
        }
    }
}

impl Drop for Hooks {
    fn drop(&mut self) {
        // SAFETY: each was installed by `install` on this thread and is removed exactly once.
        unsafe {
            let _ = UnhookWindowsHookEx(self.mouse);
            for &event in &self.events {
                let _ = UnhookWinEvent(event);
            }
            let _ = KillTimer(None, self.timer);
        }
    }
}

fn pump() {
    let mut msg = MSG::default();
    // SAFETY: the standard message loop of a thread we own.
    unsafe {
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_TIMER {
                poll_keys();
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
            if STATE.with(|state| state.borrow().as_ref().is_none_or(|s| s.done)) {
                break;
            }
        }
    }
}

/// Reports `change` once and asks the loop to end.
fn report(change: Change) {
    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        let Some(state) = state.as_mut().filter(|s| !s.done) else {
            return;
        };
        state.done = true;
        (state.on_change)(change);
    });
    // SAFETY: posting to our own thread's queue so `GetMessageW` wakes up and the loop ends.
    let _ = unsafe { PostThreadMessageW(GetCurrentThreadId(), WM_QUIT, WPARAM(0), LPARAM(0)) };
}

unsafe extern "system" fn on_win_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    _thread: u32,
    _time: u32,
) {
    let Some(target) = STATE.with(|s| s.borrow().as_ref().map(|s| s.target)) else {
        return;
    };
    let window = hwnd.0 as isize;
    let is_target_window =
        window == target && object == OBJID_WINDOW.0 && child == CHILDID_SELF as i32;
    let change = match event {
        EVENT_SYSTEM_FOREGROUND => {
            // SAFETY: plain value arguments; returns null for invalid handles.
            let root = unsafe { GetAncestor(hwnd, GA_ROOT) }.0 as isize;
            left_target(root, target).then_some(Change::SwitchedApp)
        }
        EVENT_OBJECT_LOCATIONCHANGE if is_target_window => Some(Change::Moved),
        EVENT_SYSTEM_MINIMIZESTART if window == target => Some(Change::Minimised),
        EVENT_OBJECT_DESTROY if is_target_window => Some(Change::Closed),
        // Scrolling anywhere in the target app's windows.
        EVENT_SYSTEM_SCROLLINGSTART => Some(Change::Scrolled),
        _ => None,
    };
    if let Some(change) = change {
        report(change);
    }
}

unsafe extern "system" fn on_mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        // SAFETY: for WH_MOUSE_LL with code >= 0, lparam points to an MSLLHOOKSTRUCT that is
        // valid for the duration of this call.
        let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        let (x, y) = (info.pt.x, info.pt.y);
        let event = match wparam.0 as u32 {
            WM_MOUSEWHEEL | WM_MOUSEHWHEEL => Some(Mouse::Wheel),
            WM_LBUTTONDOWN => Some(Mouse::LeftDown { x, y }),
            WM_LBUTTONUP => Some(Mouse::LeftUp),
            WM_MOUSEMOVE => Some(Mouse::Move { x, y }),
            _ => None,
        };
        let change = STATE.with(|cell| {
            let mut state = cell.borrow_mut();
            let state = state.as_mut()?;
            state.mouse_since_poll = true;
            state.mouse.on(event?)
        });
        if let Some(change) = change {
            report(change);
        }
    }
    // SAFETY: passes the event on unchanged, as every hook must.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn poll_keys() {
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` is valid with cbSize set, as the function requires.
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return;
    }
    let held = |key: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY| {
        // SAFETY: reads the key's state; no pointers. The high bit means "down now".
        (unsafe { GetAsyncKeyState(i32::from(key.0)) } as u16 & 0x8000) != 0
    };
    let modifier_down = held(VK_CONTROL) || held(VK_MENU) || held(VK_LWIN) || held(VK_RWIN);
    let change = STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        let state = state.as_mut()?;
        let mouse = std::mem::take(&mut state.mouse_since_poll);
        state
            .keys
            .poll(Instant::now(), info.dwTime, mouse, modifier_down)
    });
    if let Some(change) = change {
        report(change);
    }
}
