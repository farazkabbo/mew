//! The cursor modes' input stream (docs/CURSOR_MODES.md, A): a low-level mouse hook on its own
//! thread, running only while a cursor mode needs it.
//!
//! The hook callback does as little as possible (Windows silently removes a low-level hook that
//! is slow): it copies the position, the time and whether a button went down or up into a small
//! in-memory queue and passes the event on unchanged. It never blocks, changes or swallows an
//! event. Nothing is recorded or kept: the engine drains the queue every frame and each sample
//! replaces the last. Positions are physical pixels on the virtual desktop (the app is
//! per-monitor DPI aware v2), so monitors left of or above the primary are negative.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_QUIT, WM_RBUTTONDOWN,
};

/// More than this many events between two drains (about a second at 1000 Hz) are dropped
/// oldest-first: the engine only needs the recent past.
const QUEUE_MAX: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MouseEvent {
    Move {
        t_ms: f64,
        x: f64,
        y: f64,
    },
    /// The primary button went down (a click is about to land here).
    Down {
        t_ms: f64,
        x: f64,
        y: f64,
    },
    Up {
        t_ms: f64,
        x: f64,
        y: f64,
    },
    /// The secondary button (a context menu): ends any movement.
    Secondary {
        t_ms: f64,
    },
}

type Queue = Arc<Mutex<VecDeque<MouseEvent>>>;

thread_local! {
    static QUEUE: RefCell<Option<Queue>> = const { RefCell::new(None) };
}

/// A running hook; dropping it unhooks and ends the thread.
pub struct MouseStream {
    thread_id: u32,
    queue: Queue,
}

impl MouseStream {
    /// Starts the hook thread. None if the hook couldn't be installed.
    pub fn start() -> Option<Self> {
        let queue: Queue = Arc::new(Mutex::new(VecDeque::with_capacity(256)));
        let for_thread = Arc::clone(&queue);
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("mew-cursor-hook".into())
            .spawn(move || {
                QUEUE.with(|q| *q.borrow_mut() = Some(for_thread));
                // SAFETY: a low-level hook needs no module for a callback in this process; it
                // runs on this thread's message loop and is removed below on the same thread.
                let hook = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), None, 0) };
                // SAFETY: no arguments.
                let thread_id = unsafe { GetCurrentThreadId() };
                let _ = sender.send(hook.is_ok().then_some(thread_id));
                let Ok(hook) = hook else {
                    return;
                };
                let mut msg = MSG::default();
                // SAFETY: the standard message loop of a thread we own.
                unsafe {
                    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                    let _ = UnhookWindowsHookEx(hook);
                }
                QUEUE.with(|q| q.borrow_mut().take());
            })
            .ok()?;
        let thread_id = receiver.recv().ok()??;
        Some(Self { thread_id, queue })
    }

    /// Everything since the last drain, oldest first.
    pub fn drain(&self, into: &mut Vec<MouseEvent>) {
        let mut q = self.queue.lock().unwrap_or_else(|p| p.into_inner());
        into.extend(q.drain(..));
    }
}

impl Drop for MouseStream {
    fn drop(&mut self) {
        // SAFETY: posting to a thread id we started; harmless if it already ended.
        let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
    }
}

/// Milliseconds on the high-resolution monotonic clock (the same clock as `now_ms`).
pub fn now_ms() -> f64 {
    let (mut count, mut freq) = (0i64, 0i64);
    // SAFETY: valid out pointers; these never fail on Windows XP and later.
    unsafe {
        let _ = QueryPerformanceCounter(&mut count);
        let _ = QueryPerformanceFrequency(&mut freq);
    }
    count as f64 * 1000.0 / freq.max(1) as f64
}

unsafe extern "system" fn on_mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        // SAFETY: for WH_MOUSE_LL with code >= 0, lparam points to an MSLLHOOKSTRUCT valid for
        // the duration of this call.
        let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        // Neb's own hand (touch taps, a borrowed click) isn't the student moving.
        let injected = info.flags & LLMHF_INJECTED != 0;
        if !injected {
            let t_ms = now_ms();
            let (x, y) = (f64::from(info.pt.x), f64::from(info.pt.y));
            let event = match wparam.0 as u32 {
                WM_MOUSEMOVE => Some(MouseEvent::Move { t_ms, x, y }),
                WM_LBUTTONDOWN => Some(MouseEvent::Down { t_ms, x, y }),
                WM_LBUTTONUP => Some(MouseEvent::Up { t_ms, x, y }),
                WM_RBUTTONDOWN => Some(MouseEvent::Secondary { t_ms }),
                _ => None,
            };
            if let Some(event) = event {
                QUEUE.with(|q| {
                    if let Some(queue) = q.borrow().as_ref() {
                        // Never wait in a hook: if the engine holds the lock, drop this one.
                        if let Ok(mut q) = queue.try_lock() {
                            if q.len() >= QUEUE_MAX {
                                q.pop_front();
                            }
                            q.push_back(event);
                        }
                    }
                });
            }
        }
    }
    // SAFETY: passes the event on unchanged, as every hook must.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
