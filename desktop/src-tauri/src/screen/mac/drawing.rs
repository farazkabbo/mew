//! Local annotation only. No screen pixels, text recognition, file writes or model requests.
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
use std::sync::Mutex;
use tauri::{ipc::CapabilityBuilder, AppHandle, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut};

#[derive(Default)]
struct Session {
    frame: Option<Rect>,
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
    .map_err(|_| "Couldn't configure the drawing window.".to_owned())
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
    if tool == Tool::Select {
        return Err("Screen selection is unavailable on Mac.".into());
    }
    if tool.draws() {
        let (config, _) = super::runtime::of(app)?.snapshot();
        if config.paused || !config.privacy.show_in_captures {
            return Err("Visible Mac annotations are not enabled.".into());
        }
        let escape = Shortcut::new(None, Code::Escape);
        if !app.global_shortcut().is_registered(escape) {
            app.global_shortcut()
                .register(escape)
                .map_err(|_| "Couldn't register Escape; drawing stays off.")?;
        }
    } else {
        let _ = app
            .global_shortcut()
            .unregister(Shortcut::new(None, Code::Escape));
    }
    let window = overlay::ensure(app, Surface::Draw).map_err(|_| "Couldn't open drawing tools.")?;
    let frame = {
        let state = state(app)?;
        let mut s = state.0.lock().unwrap_or_else(|p| p.into_inner());
        // Never move existing notes onto a different display or page.
        if s.frame.is_none() {
            s.frame = input::cursor()
                .and_then(target::display_at)
                .map(|d| d.points);
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
    let _ = app
        .global_shortcut()
        .unregister(Shortcut::new(None, Code::Escape));
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
    }
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
#[tauri::command]
pub fn screen_draw_mark(window: WebviewWindow, stroke: Stroke) -> Result<(), String> {
    require(&window)?;
    let _ = stroke;
    Err("Screen selection requires Mac capture privacy checks, which are unavailable.".into())
}
#[tauri::command]
pub fn screen_draw_select(window: WebviewWindow, rect: [f32; 4]) -> Result<(), String> {
    require(&window)?;
    let _ = rect;
    Err("Screen selection requires Mac capture privacy checks, which are unavailable.".into())
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
