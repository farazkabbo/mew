//! Native drawing gestures; explicit selections hand a target-bound region to Circle & Ask.
//! All positions are CSS/Quartz points on one display; no Windows physical-pixel assumptions.
use super::{
    input, island, overlay,
    target::{self, Rect},
};
use crate::screen::{
    island::{Shape, Tool},
    surfaces::Surface,
};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{ipc::CapabilityBuilder, AppHandle, Manager, WebviewWindow};

#[derive(Clone, PartialEq)]
struct Binding {
    process: super::privacy::ProcessIdentity,
    window: target::WindowSnapshot,
    display: target::Display,
}
fn binding() -> Option<Binding> {
    let process = super::privacy::frontmost_process_identity()?;
    let front = target::frontmost_app()?;
    if process.pid != front.pid || front.bundle_id.as_deref() != Some(process.bundle_id.as_str()) {
        return None;
    }
    let window = target::frontmost_window_candidate(&front)?;
    let display = input::cursor().and_then(target::display_at)?;
    Some(Binding {
        process,
        window,
        display,
    })
}
fn same_target(expected: Option<&Binding>, actual: Option<&Binding>) -> bool {
    expected
        .zip(actual)
        .is_some_and(|(expected, actual)| expected == actual)
}
#[derive(Default)]
struct Session {
    frame: Option<Rect>,
    binding: Option<Binding>,
    tool: Tool,
    shape: Shape,
    notes: bool,
    ready: bool,
}
#[derive(Default)]
struct Drawing(Mutex<Session>);

pub fn setup(app: &AppHandle) -> Result<(), String> {
    app.manage(Drawing::default());
    app.add_capability(
        CapabilityBuilder::new("mac-drawing")
            .local(true)
            .window(Surface::Draw.label())
            .permission("allow-screen-draw-ready")
            .permission("allow-screen-draw-note")
            .permission("allow-screen-draw-pen")
            .permission("allow-screen-draw-erase")
            .permission("allow-screen-draw-mark")
            .permission("allow-screen-draw-select")
            .permission("allow-screen-draw-island-press"),
    )
    .map_err(|_| "Couldn't configure the drawing window.".to_owned())?;
    let handle = app.clone();
    let in_flight = std::sync::Arc::new(AtomicBool::new(false));
    std::thread::Builder::new()
        .name("neb-annotation-target".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let active = view(&handle);
            if active.0 == Tool::None && !active.1 {
                continue;
            }
            if in_flight.swap(true, Ordering::AcqRel) {
                continue;
            }
            let app = handle.clone();
            let busy = in_flight.clone();
            if handle
                .run_on_main_thread(move || {
                    // No AX values, titles, screen pixels or input events are read.
                    let expected = state(&app)
                        .ok()
                        .and_then(|s| s.0.lock().ok().and_then(|s| s.binding.clone()));
                    if !same_target(expected.as_ref(), binding().as_ref()) {
                        let _ = close(&app);
                        let _ = island::refresh(&app);
                    }
                    busy.store(false, Ordering::Release);
                })
                .is_err()
            {
                in_flight.store(false, Ordering::Release);
            }
        })
        .map_err(|_| "Couldn't monitor the annotation target.")?;
    Ok(())
}
fn state(app: &AppHandle) -> Result<tauri::State<'_, Drawing>, String> {
    app.try_state().ok_or_else(|| "Drawing isn't ready.".into())
}
pub fn view(app: &AppHandle) -> (Tool, bool) {
    state(app)
        .map(|s| {
            let s = s.0.lock().unwrap_or_else(|p| p.into_inner());
            (s.tool, s.notes)
        })
        .unwrap_or((Tool::None, false))
}
pub fn set_tool(app: &AppHandle, tool: Tool, shape: Shape) -> Result<(), String> {
    if tool.draws() {
        let (config, _) = super::runtime::of(app)?.snapshot();
        if config.paused || !config.privacy.show_in_captures {
            return Err("Visible Mac annotations are not enabled.".into());
        }
        crate::mac_shortcut::reserve_escape(app)?;
    }
    let window = overlay::ensure(app, Surface::Draw).map_err(|_| "Couldn't open drawing tools.")?;
    let frame = {
        let state = state(app)?;
        let mut s = state.0.lock().unwrap_or_else(|p| p.into_inner());
        // Never move existing notes onto a different display or page.
        if s.frame.is_none() {
            let target = binding().ok_or("Couldn't identify the drawing window.")?;
            if target.process.pid == std::process::id() as i32 {
                return Err("Switch to the app you want to annotate first.".into());
            }
            s.frame = Some(target.display.points);
            s.binding = Some(target);
        }
        let frame = s.frame.ok_or("Couldn't locate the drawing display.")?;
        s.tool = tool;
        s.shape = shape;
        frame
    };
    overlay::place(&window, frame).map_err(|_| "Couldn't place drawing tools.")?;
    overlay::set_click_through(&window, !tool.draws())
        .map_err(|_| "Couldn't change drawing mode.")?;
    sync(app)?;
    overlay::show_quietly(&window).map_err(|_| "Couldn't show drawing tools.")?;
    // The island stays above the drawing panel so its actual buttons receive clicks.
    if let Some(island) = app.get_webview_window(Surface::Island.label()) {
        overlay::show_quietly(&island).map_err(|_| "Couldn't show Neb tools.")?;
    }
    crate::mac_shortcut::release_escape(app);
    Ok(())
}
fn sync(app: &AppHandle) -> Result<(), String> {
    let state = state(app)?;
    let s = state.0.lock().unwrap_or_else(|p| p.into_inner());
    if !s.ready {
        return Ok(());
    }
    overlay::dispatch(app,Surface::Draw,"mew:draw-show", &serde_json::json!({
        "marks":[],"grey":true,"drawing":s.tool.annotates(),"mode":"draw","blocks":[],"pointer":null
    })).map_err(|_| "Couldn't show drawing state.")?;
    overlay::dispatch(
        app,
        Surface::Draw,
        "mew:draw-tool",
        &serde_json::json!({"tool":s.tool,"shape":s.shape}),
    )
    .map_err(|_| "Couldn't show the drawing tool.".into())
}
pub fn clear(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(Surface::Draw.label()).is_some() {
        overlay::dispatch(
            app,
            Surface::Draw,
            "mew:draw-clear-notes",
            &serde_json::json!({}),
        )
        .map_err(|_| "Couldn't clear drawings.")?;
    }
    state(app)?
        .0
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .notes = false;
    Ok(())
}
pub fn close(app: &AppHandle) -> Result<(), String> {
    // Always release/hide native input even if clearing the JS content fails.
    let mut failure = None;
    if let Some(window) = app.get_webview_window(Surface::Draw.label()) {
        if overlay::set_click_through(&window, true).is_err() {
            failure = Some("Couldn't release drawing input.");
        }
        if overlay::hide(&window).is_err() {
            failure = Some("Couldn't hide drawings.");
        }
    }
    {
        let state = state(app)?;
        let mut s = state.0.lock().unwrap_or_else(|p| p.into_inner());
        s.tool = Tool::None;
        s.frame = None;
        s.binding = None;
    }
    crate::mac_shortcut::release_escape(app);
    sync(app)?;
    clear(app)?;
    failure.map_or(Ok(()), |message| Err(message.into()))
}

fn valid_point(at: [f32; 2], frame: Rect) -> bool {
    at.iter().all(|v| v.is_finite())
        && at[0] >= 0.
        && at[1] >= 0.
        && f64::from(at[0]) < frame.width
        && f64::from(at[1]) < frame.height
}
fn require(window: &WebviewWindow) -> Result<(), String> {
    overlay::require_surface(window, Surface::Draw)
}
#[tauri::command]
pub fn screen_draw_ready(window: WebviewWindow) -> Result<(), String> {
    require(&window)?;
    let app = window.app_handle();
    state(app)?
        .0
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .ready = true;
    sync(app)
}
#[tauri::command]
pub fn screen_draw_note(window: WebviewWindow, at: [f32; 2]) -> Result<(), String> {
    require(&window)?;
    let app = window.app_handle();
    {
        let state = state(app)?;
        let mut s = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if s.tool != Tool::Pen || !s.frame.is_some_and(|f| valid_point(at, f)) {
            return Err("No active pen session.".into());
        }
        s.notes = true;
    }
    island::refresh(app)
}
#[tauri::command]
pub fn screen_draw_pen(window: WebviewWindow, at: [f32; 2]) -> Result<(), String> {
    require(&window)?;
    let state = state(window.app_handle())?;
    let s = state.0.lock().unwrap_or_else(|p| p.into_inner());
    if !s.frame.is_some_and(|f| valid_point(at, f)) {
        return Err("Invalid pen position.".into());
    }
    Ok(()) // Hover is informational; never reads the app underneath or injects an event.
}
#[tauri::command]
pub fn screen_draw_erase(window: WebviewWindow) -> Result<(), String> {
    require(&window)?;
    let app = window.app_handle();
    if !view(app).0.annotates() {
        return Err("No active drawing session.".into());
    }
    let shape = state(app)?
        .0
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .shape;
    set_tool(app, Tool::Eraser, shape)
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Stroke {
    points: Vec<[f32; 3]>,
    #[serde(default)]
    dashed: bool,
}
fn selection(app: &AppHandle, rect: [f32; 4]) -> Result<(), String> {
    let (region, expected) = {
        let h = state(app)?;
        let s = h.0.lock().unwrap_or_else(|p| p.into_inner());
        if s.tool != Tool::Select {
            return Err("Choose the selection tool first.".into());
        }
        let display = s.frame.ok_or("The drawing session ended.")?;
        let bound = s.binding.as_ref().ok_or("The drawing target changed.")?;
        let [x, y, w, h] = rect;
        if !rect.iter().all(|v| v.is_finite())
            || x < 0.
            || y < 0.
            || w < 4.
            || h < 4.
            || f64::from(x + w) > display.width
            || f64::from(y + h) > display.height
        {
            return Err("Select an area inside this display.".into());
        }
        let region = Rect::new(
            display.x + f64::from(x),
            display.y + f64::from(y),
            f64::from(w),
            f64::from(h),
        )
        .ok_or("Invalid selection.")?;
        (
            region,
            super::pipeline::Target {
                window_id: bound.window.id,
                process: bound.process.clone(),
                quartz_points: bound.window.bounds,
            },
        )
    };
    // The non-key drawing panel must be gone before capture, and the captured target must
    // still be the original process launch/window. No pixels are acquired by this handler.
    close(app)?;
    let app = app.clone();
    std::thread::Builder::new()
        .name("neb-mac-selection".into())
        .spawn(move || {
            if let Err(message) = super::circle::select_bound(&app, region, expected) {
                crate::screen::page::dispatch(
                    &app,
                    crate::screen::page::SAY,
                    serde_json::json!({"text":message.chars().take(300).collect::<String>()}),
                );
            }
        })
        .map_err(|_| "Couldn't begin the screen selection.")?;
    Ok(())
}
#[tauri::command]
pub fn screen_draw_mark(window: WebviewWindow, stroke: Stroke) -> Result<(), String> {
    require(&window)?;
    if !(3..=4000).contains(&stroke.points.len())
        || stroke.points.iter().flatten().any(|v| !v.is_finite())
    {
        return Err("Invalid selection stroke.".into());
    }
    let mut bounds = [
        f32::INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
    ];
    for [x, y, _] in stroke.points {
        bounds[0] = bounds[0].min(x);
        bounds[1] = bounds[1].min(y);
        bounds[2] = bounds[2].max(x);
        bounds[3] = bounds[3].max(y);
    }
    selection(
        window.app_handle(),
        [
            bounds[0],
            bounds[1],
            bounds[2] - bounds[0],
            bounds[3] - bounds[1],
        ],
    )
}
#[tauri::command]
pub fn screen_draw_select(window: WebviewWindow, rect: [f32; 4]) -> Result<(), String> {
    require(&window)?;
    selection(window.app_handle(), rect)
}
#[tauri::command]
pub fn screen_draw_island_press(window: WebviewWindow, at: [f32; 2]) -> Result<(), String> {
    require(&window)?;
    let _ = at;
    Err("Use the island's native buttons.".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn annotations_cancel_on_unknown_launch_window_geometry_or_display_changes() {
        let frame = Rect::new(-1512., 0., 1512., 982.).unwrap();
        let initial = Binding {
            process: super::super::privacy::ProcessIdentity {
                pid: 42,
                bundle_id: "example.editor".into(),
                launch_time_bits: 1.0_f64.to_bits(),
            },
            window: target::WindowSnapshot {
                id: 7,
                pid: 42,
                bounds: frame,
                layer: 0,
                alpha: Some(1.),
            },
            display: target::Display::new(1, frame, 3024, 1964).unwrap(),
        };
        assert!(same_target(Some(&initial), Some(&initial)));
        assert!(!same_target(Some(&initial), None));
        assert!(!same_target(None, None));
        let mut relaunch = initial.clone();
        relaunch.process.launch_time_bits = 2.0_f64.to_bits();
        let mut window = initial.clone();
        window.window.id += 1;
        let mut moved = initial.clone();
        moved.window.bounds.x += 1.;
        let mut display = initial.clone();
        display.display.id += 1;
        for changed in [relaunch, window, moved, display] {
            assert!(!same_target(Some(&initial), Some(&changed)));
        }
    }

    #[test]
    fn local_points_use_points_not_retina_pixels_or_global_origins() {
        let f = Rect::new(-1512., -200., 1512., 982.).unwrap();
        assert!(valid_point([1511., 981.], f));
        for p in [
            [1512., 0.],
            [-1., 0.],
            [0., 982.],
            [f32::NAN, 0.],
            [3023., 1963.],
        ] {
            assert!(!valid_point(p, f));
        }
    }
}
