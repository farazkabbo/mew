//! Native drawing gestures; explicit selections hand a target-bound region to Circle & Ask.
//! All positions are CSS/Quartz points on one display; no Windows physical-pixel assumptions.
use super::{
    input, island, overlay,
    target::{self, Rect},
};
use crate::screen::{
    frame::ScreenRect,
    island::{Shape, Tool},
    surfaces::Surface,
};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
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
    keyboard: bool,
    selecting_question: bool,
}
#[derive(Default)]
struct Drawing(Mutex<Session>, Arc<AtomicU64>);

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
                    let own_keyboard = super::circle::stored_target_current_main(&app);
                    if !own_keyboard && !same_target(expected.as_ref(), binding().as_ref()) {
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
    let (tool, notes) = state(app)
        .map(|h| {
            let s = h.0.lock().unwrap_or_else(|p| p.into_inner());
            (s.tool, s.notes)
        })
        .unwrap_or((Tool::None, false));
    (tool, notes || super::circle::has_visual_marks(app))
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
            state.1.fetch_add(1, Ordering::AcqRel);
            s.frame = Some(target.display.points);
            s.binding = Some(target);
        }
        let frame = s.frame.ok_or("Couldn't locate the drawing display.")?;
        if s.tool != tool {
            state.1.fetch_add(1, Ordering::AcqRel);
        }
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
pub(super) fn sync(app: &AppHandle) -> Result<(), String> {
    // Snapshot before calling Circle: its native stored-frame grant also checks keyboard state.
    let (ready, frame, tool, shape, question, keyboard) = {
        let h = state(app)?;
        let s = h.0.lock().unwrap_or_else(|p| p.into_inner());
        (
            s.ready,
            s.frame,
            s.tool,
            s.shape,
            s.selecting_question,
            s.keyboard,
        )
    };
    if !ready {
        return Ok(());
    }
    let (marks, blocks) = frame
        .map(|display| super::circle::drawing_view(app, display))
        .unwrap_or((serde_json::json!([]), vec![]));
    overlay::dispatch(app,Surface::Draw,"mew:draw-show",&serde_json::json!({"marks":marks,"grey":false,"drawing":tool.draws(),"mode":if question{"select"}else if keyboard{"keyboard"}else{"draw"},"blocks":blocks,"pointer":null})).map_err(|_|"Couldn't show drawing state.")?;
    overlay::dispatch(
        app,
        Surface::Draw,
        "mew:draw-tool",
        &serde_json::json!({"tool":tool,"shape":shape}),
    )
    .map_err(|_| "Couldn't show the drawing tool.".into())
}
pub fn clear(app: &AppHandle) -> Result<(), String> {
    super::note_scroll::stop(app);
    super::circle::cancel_all(app);
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
    sync(app)
}
pub fn close(app: &AppHandle) -> Result<(), String> {
    // Always release/hide native input even if clearing the JS content fails.
    let mut failure = None;
    if let Some(window) = app.get_webview_window(Surface::Draw.label()) {
        let _ = overlay::set_activatable(&window, false);
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
        state.1.fetch_add(1, Ordering::AcqRel);
        s.tool = Tool::None;
        s.frame = None;
        s.binding = None;
        s.keyboard = false;
        s.selecting_question = false;
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
        if !s.notes {
            if let Some(frame) = s.frame {
                super::note_scroll::follow(
                    app,
                    super::target::Point {
                        x: frame.x + f64::from(at[0]),
                        y: frame.y + f64::from(at[1]),
                    },
                );
            }
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
    if let Some(frame) = s.frame {
        super::pointer::pen(
            window.app_handle(),
            super::target::Point {
                x: frame.x + f64::from(at[0]),
                y: frame.y + f64::from(at[1]),
            },
        );
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
pub(super) fn block_points(
    rect: ScreenRect,
    window: Rect,
    display: Rect,
    size: (u32, u32),
) -> [f32; 4] {
    [
        (window.x + f64::from(rect.left) / f64::from(size.0) * window.width - display.x) as f32,
        (window.y + f64::from(rect.top) / f64::from(size.1) * window.height - display.y) as f32,
        (f64::from(rect.width()) / f64::from(size.0) * window.width) as f32,
        (f64::from(rect.height()) / f64::from(size.1) * window.height) as f32,
    ]
}
pub fn keyboard_active(app: &AppHandle) -> bool {
    state(app).is_ok_and(|h| h.0.lock().unwrap_or_else(|p| p.into_inner()).keyboard)
}
fn same_completion(
    epoch: u64,
    generation: u64,
    expected: &super::pipeline::Target,
    current_epoch: u64,
    current_generation: u64,
    current: Option<&super::pipeline::Target>,
) -> bool {
    epoch == current_epoch && generation == current_generation && current == Some(expected)
}
fn completion_current(
    app: &AppHandle,
    epoch: u64,
    generation: u64,
    expected: &super::pipeline::Target,
    serial: Option<u64>,
) -> bool {
    let Ok(h) = state(app) else {
        return false;
    };
    let (current_epoch, current) = {
        let s = h.0.lock().unwrap_or_else(|p| p.into_inner());
        (
            h.1.load(Ordering::Acquire),
            s.frame
                .and(s.binding.as_ref().map(|b| super::pipeline::Target {
                    window_id: b.window.id,
                    process: b.process.clone(),
                    quartz_points: b.window.bounds,
                })),
        )
    };
    let Ok(r) = super::runtime::of(app) else {
        return false;
    };
    let current_generation = r.generation.load(Ordering::Acquire);
    same_completion(
        epoch,
        generation,
        expected,
        current_epoch,
        current_generation,
        current.as_ref(),
    ) && serial.is_none_or(|serial| super::circle::still(app, serial))
}
pub fn toggle_keyboard(app: &AppHandle) -> Result<(), String> {
    if keyboard_active(app) {
        {
            let h = state(app)?;
            let mut s = h.0.lock().unwrap_or_else(|p| p.into_inner());
            h.1.fetch_add(1, Ordering::AcqRel);
            s.keyboard = false;
            s.tool = Tool::None;
        }
        if let Some(w) = app.get_webview_window(Surface::Draw.label()) {
            let _ = overlay::set_activatable(&w, false);
            let _ = overlay::set_click_through(&w, true);
        }
        if super::circle::has_marks(app) {
            if let Some(w) = app.get_webview_window(Surface::Card.label()) {
                let _ = w.set_focus();
            }
            sync(app)?;
        } else {
            super::circle::cancel_all(app);
            if let Some(w) = app.get_webview_window(Surface::Draw.label()) {
                let _ = overlay::hide(&w);
            }
        }
        return super::island::refresh(app);
    }
    set_tool(app, Tool::Select, Shape::Free)?;
    let (epoch, expected) = {
        let h = state(app)?;
        let s = h.0.lock().unwrap_or_else(|p| p.into_inner());
        let bound = s.binding.as_ref().ok_or("The drawing target changed.")?;
        (
            h.1.load(Ordering::Acquire),
            super::pipeline::Target {
                window_id: bound.window.id,
                process: bound.process.clone(),
                quartz_points: bound.window.bounds,
            },
        )
    };
    if let Some(w) = app.get_webview_window(Surface::Draw.label()) {
        let _ = overlay::hide(&w);
    }
    let generation = super::runtime::of(app)?.generation.load(Ordering::Acquire);
    let guard = state(app)?.1.clone();
    let circle_epoch = super::circle::epoch(app);
    let handle = app.clone();
    std::thread::Builder::new()
        .name("neb-mac-keyboard-select".into())
        .spawn(move || {
            if !completion_current(&handle, epoch, generation, &expected, None) {
                return;
            }
            let active = || guard.load(Ordering::Acquire) == epoch;
            let result = super::circle::prepare_checked(
                &handle,
                Some(expected.clone()),
                generation,
                circle_epoch,
                &active,
            );
            let app = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                let serial = result.as_ref().ok().copied();
                if !completion_current(&app, epoch, generation, &expected, serial) {
                    return;
                }
                if result.is_ok() {
                    if let Ok(h) = state(&app) {
                        h.0.lock().unwrap_or_else(|p| p.into_inner()).keyboard = true;
                    }
                    let _ = sync(&app);
                    if let Some(w) = app.get_webview_window(Surface::Draw.label()) {
                        let _ = overlay::set_activatable(&w, true);
                        let _ = overlay::show_quietly(&w);
                        let _ = w.set_focus();
                    }
                } else {
                    let _ = close(&app);
                }
            });
        })
        .map_err(|_| "Couldn't start keyboard selection.")?;
    Ok(())
}
pub fn select_question(app: &AppHandle) -> Result<(), String> {
    {
        let h = state(app)?;
        let mut s = h.0.lock().unwrap_or_else(|p| p.into_inner());
        if s.frame.is_none() {
            return Err("The drawing session ended.".into());
        }
        h.1.fetch_add(1, Ordering::AcqRel);
        s.selecting_question = true;
    }
    sync(app)?;
    if let Some(w) = app.get_webview_window(Surface::Draw.label()) {
        overlay::set_click_through(&w, false).map_err(|_| "Couldn't select the question.")?;
        overlay::show_quietly(&w).map_err(|_| "Couldn't show question selection.")?;
    }
    Ok(())
}
fn submit(
    app: &AppHandle,
    points: Vec<[f32; 3]>,
    dashed: bool,
    question: bool,
) -> Result<(), String> {
    let (points, expected, region, epoch) = {
        let h = state(app)?;
        let s = h.0.lock().unwrap_or_else(|p| p.into_inner());
        if s.tool != Tool::Select {
            return Err("Choose the selection tool first.".into());
        }
        let display = s.frame.ok_or("The drawing session ended.")?;
        let bound = s.binding.as_ref().ok_or("The drawing target changed.")?;
        if points.is_empty()
            || points.len() > 4000
            || points
                .iter()
                .any(|p| !valid_point([p[0], p[1]], display) || !p[2].is_finite())
        {
            return Err("Draw inside this display.".into());
        }
        let points = points
            .into_iter()
            .map(|p| {
                (
                    (display.x + f64::from(p[0])) as f32,
                    (display.y + f64::from(p[1])) as f32,
                )
            })
            .collect::<Vec<_>>();
        let left = points.iter().map(|p| p.0).fold(f32::INFINITY, f32::min);
        let right = points.iter().map(|p| p.0).fold(f32::NEG_INFINITY, f32::max);
        let top = points.iter().map(|p| p.1).fold(f32::INFINITY, f32::min);
        let bottom = points.iter().map(|p| p.1).fold(f32::NEG_INFINITY, f32::max);
        (
            points,
            super::pipeline::Target {
                window_id: bound.window.id,
                process: bound.process.clone(),
                quartz_points: bound.window.bounds,
            },
            Rect::new(
                f64::from(left),
                f64::from(top),
                f64::from(right - left),
                f64::from(bottom - top),
            ),
            h.1.load(Ordering::Acquire),
        )
    };
    if !keyboard_active(app) {
        if let Some(w) = app.get_webview_window(Surface::Draw.label()) {
            let _ = overlay::hide(&w);
        }
    }
    let generation = super::runtime::of(app)?.generation.load(Ordering::Acquire);
    let origin_serial = super::circle::current_serial(app);
    let circle_epoch = super::circle::epoch(app);
    let guard = state(app)?.1.clone();
    let handle = app.clone();
    std::thread::Builder::new()
        .name("neb-mac-selection".into())
        .spawn(move || {
            if !completion_current(&handle, epoch, generation, &expected, origin_serial) {
                return;
            }
            let active = || guard.load(Ordering::Acquire) == epoch;
            let result = if question {
                region
                    .ok_or_else(|| "Select a question area.".to_owned())
                    .and_then(|r| {
                        origin_serial
                            .ok_or_else(|| "The question selection expired.".to_owned())
                            .and_then(|serial| {
                                super::circle::read_selected_question_checked(
                                    &handle, r, serial, &active,
                                )
                            })
                    })
            } else {
                super::circle::mark_bound_checked(
                    &handle,
                    points,
                    dashed,
                    Some(expected.clone()),
                    generation,
                    circle_epoch,
                    &active,
                )
            };
            let app = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                let serial = result.as_ref().ok().copied().or(origin_serial);
                if !completion_current(&app, epoch, generation, &expected, serial) {
                    return;
                }
                if let Ok(h) = state(&app) {
                    h.0.lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .selecting_question = false;
                }
                let _ = sync(&app);
                if state(&app).is_ok_and(|h| {
                    h.0.lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .frame
                        .is_some()
                }) && super::circle::has_session(&app)
                {
                    if let Some(w) = app.get_webview_window(Surface::Draw.label()) {
                        let _ = overlay::show_quietly(&w);
                    }
                }
                if let Err(message) = result {
                    crate::screen::page::dispatch(
                        &app,
                        crate::screen::page::SAY,
                        serde_json::json!({"text":message.chars().take(300).collect::<String>()}),
                    );
                }
            });
        })
        .map_err(|_| "Couldn't begin screen selection.")?;
    Ok(())
}
#[tauri::command]
pub fn screen_draw_mark(window: WebviewWindow, stroke: Stroke) -> Result<(), String> {
    require(&window)?;
    submit(window.app_handle(), stroke.points, stroke.dashed, false)
}
#[tauri::command]
pub fn screen_draw_select(window: WebviewWindow, rect: [f32; 4]) -> Result<(), String> {
    require(&window)?;
    let [x, y, w, h] = rect;
    if !rect.iter().all(|v| v.is_finite()) || w < 4. || h < 4. {
        return Err("Select a question area.".into());
    }
    submit(
        window.app_handle(),
        vec![
            [x, y, 0.5],
            [x + w, y, 0.5],
            [x + w, y + h, 0.5],
            [x, y + h, 0.5],
            [x, y, 0.5],
        ],
        true,
        true,
    )
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
    #[test]
    fn keyboard_blocks_convert_capture_pixels_to_negative_display_css_points() {
        let rect = ScreenRect {
            left: 200,
            top: 100,
            right: 600,
            bottom: 300,
        };
        let window = Rect::new(-900., -50., 1000., 500.).unwrap();
        let display = Rect::new(-1000., -100., 1200., 800.).unwrap();
        assert_eq!(
            block_points(rect, window, display, (2000, 1000)),
            [200., 100., 200., 100.]
        );
    }
    #[test]
    fn delayed_drawing_completion_cannot_modify_replaced_or_cancelled_session() {
        let expected = super::super::pipeline::Target {
            window_id: 7,
            process: super::super::privacy::ProcessIdentity {
                pid: 42,
                bundle_id: "com.apple.TextEdit".into(),
                launch_time_bits: 1f64.to_bits(),
            },
            quartz_points: Rect::new(-600., 0., 500., 400.).unwrap(),
        };
        assert!(same_completion(3, 9, &expected, 3, 9, Some(&expected)));
        assert!(!same_completion(3, 9, &expected, 4, 9, Some(&expected)));
        assert!(!same_completion(3, 9, &expected, 3, 10, Some(&expected)));
        assert!(!same_completion(3, 9, &expected, 3, 9, None));
        let mut replacement = expected.clone();
        replacement.process.launch_time_bits = 2f64.to_bits();
        assert!(!same_completion(3, 9, &expected, 3, 9, Some(&replacement)));
        replacement = expected.clone();
        replacement.window_id += 1;
        assert!(!same_completion(3, 9, &expected, 3, 9, Some(&replacement)));
        replacement = expected.clone();
        replacement.quartz_points.x += 1.;
        assert!(!same_completion(3, 9, &expected, 3, 9, Some(&replacement)));
    }
}
