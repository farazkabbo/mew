//! Native companion pointer. Only current pointer/pen coordinates and bounded policy metadata
//! are sampled; no captures, field values, input posting or cursor history are retained.
use super::{
    app_policy, call_signals, companion_policy, drawing, input, overlay, privacy, runtime, target,
};
use crate::screen::{
    frame::ScreenRect,
    pointer::{self, Hide, PointerLook},
    surfaces::Surface,
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
#[derive(Default)]
struct Host {
    pen: Mutex<Option<(target::Point, Option<target::Point>)>>,
}
pub fn pen(app: &AppHandle, at: target::Point) {
    if let Some(h) = app.try_state::<Host>() {
        *h.pen.lock().unwrap_or_else(|p| p.into_inner()) = Some((at, input::cursor()));
    }
}
pub fn setup(app: &AppHandle) -> Result<(), String> {
    if !app.manage(Host::default()) {
        return Err("Companion pointer already initialized.".into());
    }
    let app = app.clone();
    let pending = std::sync::Arc::new(AtomicBool::new(false));
    std::thread::Builder::new()
        .name("neb-mac-companion".into())
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
        .map_err(|_| "Couldn't start the companion pointer.")?;
    Ok(())
}
fn hide(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(Surface::Pointer.label()) {
        let _ = overlay::hide(&w);
    }
}
fn tick(app: &AppHandle) {
    let Ok(r) = runtime::of(app) else {
        return;
    };
    let (c, reset) = r.snapshot();
    if reset || !c.is_on() || c.paused || !c.privacy.show_in_captures {
        hide(app);
        return;
    }
    let cursor = input::cursor();
    let at = app
        .try_state::<Host>()
        .and_then(|h| *h.pen.lock().unwrap_or_else(|p| p.into_inner()))
        .filter(|(_, mouse)| *mouse == cursor)
        .map(|p| p.0)
        .or(cursor);
    let Some(at) = at else {
        hide(app);
        return;
    };
    let Some(display) = target::display_at(at) else {
        hide(app);
        return;
    };
    let process = privacy::frontmost_process_identity();
    let window = process.as_ref().and_then(|p| {
        target::frontmost_window_candidate(&target::AppIdentity {
            pid: p.pid,
            bundle_id: Some(p.bundle_id.clone()),
        })
    });
    let fullscreen = window.as_ref().is_some_and(|w| {
        (w.bounds.x - display.points.x).abs() < 1.
            && (w.bounds.y - display.points.y).abs() < 1.
            && (w.bounds.width - display.points.width).abs() < 1.
            && (w.bounds.height - display.points.height).abs() < 1.
    });
    let blocked = process.as_ref().is_none_or(|p| {
        app_policy::classify_app(&p.bundle_id) == app_policy::AppClass::Blocked
            || app_policy::blocked_app(&p.bundle_id, &c.privacy.blocked_apps).is_some()
    });
    let drawing = drawing::view(app).0.draws();
    let deadline = Instant::now() + Duration::from_millis(65);
    let calls_clear = !c.privacy.pause_during_calls
        || call_signals::sample(deadline, &|| Instant::now() < deadline).state
            == call_signals::SignalState::KnownSignalsIdle;
    if !companion_policy::track_allowed(
        c.is_on(),
        c.paused,
        c.privacy.show_in_captures,
        fullscreen,
        calls_clear,
    ) || !pointer::shows(
        c.circle.pointer,
        drawing,
        Hide {
            blocked_app: blocked,
            ..Hide::default()
        },
    ) {
        hide(app);
        return;
    }
    let look = if blocked {
        PointerLook::Blocked
    } else if super::ask::listening(app) {
        PointerLook::Listening
    } else if drawing {
        PointerLook::Drawing
    } else if super::ask::engaged(app) || super::hand::engaged(app) {
        PointerLook::Thinking
    } else if super::circle::has_session(app) {
        PointerLook::Explaining
    } else {
        PointerLook::Idle
    };
    let b = display.points;
    let rect = pointer::pointer_spot(
        (at.x.round() as i32, at.y.round() as i32),
        c.circle.pointer_size,
        c.circle.pointer_corner,
        1.,
        ScreenRect {
            left: b.x.ceil() as i32,
            top: b.y.ceil() as i32,
            right: (b.x + b.width).floor() as i32,
            bottom: (b.y + b.height).floor() as i32,
        },
    );
    if let Ok(w) = overlay::ensure(app, Surface::Pointer) {
        if let Some(rect) = target::Rect::new(
            f64::from(rect.left),
            f64::from(rect.top),
            f64::from(rect.width()),
            f64::from(rect.height()),
        ) {
            let _ = overlay::place(&w, rect);
        }
        let _ = overlay::dispatch(
            app,
            Surface::Pointer,
            "mew:pointer-look",
            &serde_json::json!({"look":look}),
        );
        let _ = overlay::show_quietly(&w);
    }
}
