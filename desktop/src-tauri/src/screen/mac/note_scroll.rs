//! Follow handwriting using bounded AX geometry only. The scroll area's content position is
//! sampled on the AppKit thread; no field values/text/pixels, AX actions or input are read.
use super::{companion_policy, hand_policy_ax as ax, overlay, privacy, target};
use crate::screen::surfaces::Surface;
use std::{
    cell::RefCell,
    ffi::c_void,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
type Cf = *const c_void;
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCopyElementAtPosition(app: Cf, x: f32, y: f32, out: *mut Cf) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFArrayGetTypeID() -> usize;
    fn CFGetTypeID(value: Cf) -> usize;
    fn CFArrayGetCount(value: Cf) -> isize;
    fn CFArrayGetValueAtIndex(value: Cf, index: isize) -> Cf;
    fn CFRetain(value: Cf) -> Cf;
}
#[derive(Default)]
struct Host {
    serial: AtomicU64,
}
struct Follow {
    serial: u64,
    process: privacy::ProcessIdentity,
    window: u32,
    bounds: target::Rect,
    contents: ax::Owned,
    base: (f64, f64),
    last: (f64, f64),
}
thread_local! {static FOLLOW:RefCell<Option<Follow>>=const{RefCell::new(None)};}
pub fn setup(app: &AppHandle) -> Result<(), String> {
    if !app.manage(Host::default()) {
        return Err("Note following already initialized.".into());
    }
    let app = app.clone();
    let pending = Arc::new(AtomicBool::new(false));
    std::thread::Builder::new()
        .name("neb-mac-note-scroll".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(33));
            if pending.swap(true, Ordering::AcqRel) {
                continue;
            }
            let handle = app.clone();
            let busy = pending.clone();
            if app
                .run_on_main_thread(move || {
                    tick(&handle);
                    busy.store(false, Ordering::Release);
                })
                .is_err()
            {
                pending.store(false, Ordering::Release);
            }
        })
        .map_err(|_| "Couldn't start note following.")?;
    Ok(())
}
pub fn stop(app: &AppHandle) {
    if let Some(h) = app.try_state::<Host>() {
        h.serial.fetch_add(1, Ordering::AcqRel);
    }
    let _ = app.run_on_main_thread(|| {
        FOLLOW.with(|f| {
            f.borrow_mut().take();
        })
    });
}
pub fn follow(app: &AppHandle, at: target::Point) {
    let Some(h) = app.try_state::<Host>() else {
        return;
    };
    let serial = h.serial.load(Ordering::Acquire);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if FOLLOW.with(|f| f.borrow().as_ref().is_some_and(|f| f.serial == serial)) {
            return;
        }
        let _ =
            begin(&handle, at, serial).map(|found| FOLLOW.with(|f| *f.borrow_mut() = Some(found)));
    });
}
fn position(value: &ax::Owned, deadline: Instant) -> Option<(f64, f64)> {
    let p = ax::pair(ax::attr(value.0, "AXPosition", deadline)?.0, 1)?;
    Some((p.a, p.b))
}
fn begin(app: &AppHandle, at: target::Point, serial: u64) -> Option<Follow> {
    let deadline = Instant::now() + Duration::from_millis(100);
    let process = privacy::frontmost_process_identity()?;
    let window = target::frontmost_window_candidate(&target::AppIdentity {
        pid: process.pid,
        bundle_id: Some(process.bundle_id.clone()),
    })?;
    if process.pid == std::process::id() as i32 || !window.bounds.contains(at) {
        return None;
    }
    let application = ax::application(process.pid)?;
    if !ax::element(application.0, process.pid) {
        return None;
    }
    let mut hit = std::ptr::null();
    if unsafe {
        AXUIElementCopyElementAtPosition(application.0, at.x as f32, at.y as f32, &mut hit)
    } != 0
    {
        return None;
    }
    let mut current = ax::Owned::new(hit)?;
    for _ in 0..12 {
        if !ax::element(current.0, process.pid) || Instant::now() >= deadline {
            return None;
        }
        let role = ax::string(ax::attr(current.0, "AXRole", deadline)?.0)?;
        if role == "AXScrollArea" {
            let array = ax::attr(current.0, "AXContents", deadline)?;
            if unsafe {
                CFGetTypeID(array.0) != CFArrayGetTypeID() || CFArrayGetCount(array.0) != 1
            } {
                return None;
            }
            let contents = ax::Owned::new(unsafe { CFRetain(CFArrayGetValueAtIndex(array.0, 0)) })?;
            if !ax::element(contents.0, process.pid) {
                return None;
            }
            let base = position(&contents, deadline)?;
            if app.try_state::<Host>()?.serial.load(Ordering::Acquire) != serial {
                return None;
            }
            return Some(Follow {
                serial,
                process,
                window: window.id,
                bounds: window.bounds,
                contents,
                base,
                last: base,
            });
        }
        current = ax::attr(current.0, "AXParent", deadline)?;
    }
    None
}
fn tick(app: &AppHandle) {
    FOLLOW.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(f) = slot.as_mut() else {
            return;
        };
        let current = app
            .try_state::<Host>()
            .is_some_and(|h| h.serial.load(Ordering::Acquire) == f.serial)
            && privacy::process_identity(f.process.pid).as_ref() == Some(&f.process)
            && target::visible_windows().is_some_and(|windows| {
                windows
                    .iter()
                    .any(|w| w.id == f.window && w.pid == f.process.pid && w.bounds == f.bounds)
            });
        if !current {
            slot.take();
            return;
        }
        let Some(now) = position(&f.contents, Instant::now() + Duration::from_millis(25)) else {
            return;
        };
        if (now.0 - f.last.0).abs() < 0.5 && (now.1 - f.last.1).abs() < 0.5 {
            return;
        }
        let Some((dx, dy)) = companion_policy::shifted(f.base, now) else {
            return;
        };
        f.last = now;
        let _ = overlay::dispatch(
            app,
            Surface::Draw,
            "mew:draw-notes-shift",
            &serde_json::json!({"dx":dx,"dy":dy}),
        );
    });
}
