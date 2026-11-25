//! Mac Dynamic Island host. Reuses the Windows page/protocol and the native non-activating
//! overlay panel. Feature services must be supplied before setup: this host never fabricates
//! a successful microphone, screen capture, Watch or media operation.
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WebviewWindow};

use super::{
    input, overlay,
    target::{self, Rect},
};
use crate::screen::{
    config::HelpLevel,
    island::{
        IslandAction, IslandView, Shape, Tool, ISLAND_MENU_HEIGHT, ISLAND_SIZE,
        ISLAND_WINDOW_HEIGHT,
    },
    music::Control,
    surfaces::Surface,
};

/// Every Windows island action has a native service contract; unsupported operations return
/// an error and retain the last truthful view. Never substitute a successful no-op.
pub trait Actions: Send + Sync + 'static {
    fn view(&self) -> IslandView;
    fn set_tool(&self, tool: Tool) -> Result<(), String>;
    fn set_shape(&self, shape: Shape) -> Result<(), String>;
    fn toggle_mic(&self) -> Result<(), String>;
    fn toggle_watch(&self) -> Result<(), String>;
    fn set_help(&self, level: HelpLevel) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
    fn close(&self) -> Result<(), String>;
    fn music_panel(&self, open: bool) -> Result<(), String>;
    fn music_control(&self, control: Control) -> Result<(), String>;
    fn music_pin(&self) -> Result<(), String>;
    fn music_open(&self, id: &str) -> Result<(), String>;
    fn music_unpin(&self, id: &str) -> Result<(), String>;
}

#[derive(Default)]
struct Layout {
    frame: Option<Rect>,
    visible: bool,
}
struct Host {
    actions: Arc<dyn Actions>,
    layout: Mutex<Layout>,
}

/// Internal native setup, not exposed to remote pages. The caller installs a local-only
/// Island capability and this command's handler before making the window.
pub fn setup(app: &AppHandle, actions: Arc<dyn Actions>) -> Result<(), String> {
    if !app.manage(Host {
        actions,
        layout: Mutex::new(Layout::default()),
    }) {
        return Err("Neb tools are already initialized.".into());
    }
    Ok(())
}

fn host(app: &AppHandle) -> Result<tauri::State<'_, Host>, String> {
    app.try_state::<Host>()
        .ok_or_else(|| "Neb tools are unavailable.".into())
}

/// The only layout input is a validated display rectangle and its native safe/menu inset.
/// Everything remains in Quartz points; backing scale is irrelevant to WKWebView CSS size.
pub fn island_frame(display: Rect, safe_top: f64, height: f64) -> Option<Rect> {
    Rect::new(display.x, display.y, display.width, display.height)?;
    if !safe_top.is_finite() || safe_top < 0. || safe_top >= display.height || !height.is_finite() {
        return None;
    }
    let width = ISLAND_SIZE.0.min(display.width);
    Rect::new(
        display.x + (display.width - width) / 2.,
        display.y + safe_top,
        width,
        height
            .clamp(ISLAND_SIZE.1, ISLAND_WINDOW_HEIGHT)
            .min(display.height - safe_top),
    )
}

fn safe_top(display: Rect) -> Option<f64> {
    let mtm = objc2::MainThreadMarker::new()?;
    let primary = target::main_display()?;
    let appkit = display.to_appkit(primary.points.height)?;
    for screen in objc2_app_kit::NSScreen::screens(mtm).iter() {
        let frame = screen.frame();
        if (frame.origin.x - appkit.x).abs() < 1.
            && (frame.origin.y - appkit.y).abs() < 1.
            && (frame.size.width - appkit.width).abs() < 1.
            && (frame.size.height - appkit.height).abs() < 1.
        {
            let visible = screen.visibleFrame();
            let menu = frame.origin.y + frame.size.height - visible.origin.y - visible.size.height;
            return Some(menu.max(screen.safeAreaInsets().top).max(0.));
        }
    }
    None
}

/// Main-thread native tray/gesture action. Shows no page content or screen pixels.
pub fn show(app: &AppHandle) -> Result<(), String> {
    let state = host(app)?;
    if objc2::MainThreadMarker::new().is_none() {
        return Err("Neb tools need the main thread.".into());
    }
    let display = input::cursor()
        .and_then(target::display_at)
        .ok_or("Couldn't locate the display.")?;
    let inset = safe_top(display.points).ok_or("Couldn't locate the display safe area.")?;
    let frame =
        island_frame(display.points, inset, ISLAND_SIZE.1).ok_or("Couldn't place Neb tools.")?;
    let window = overlay::ensure(app, Surface::Island).map_err(|_| "Couldn't open Neb tools.")?;
    overlay::place(&window, frame).map_err(|_| "Couldn't place Neb tools.")?;
    overlay::show_quietly(&window).map_err(|_| "Couldn't show Neb tools.")?;
    {
        let mut layout = state.layout.lock().unwrap_or_else(|p| p.into_inner());
        layout.frame = Some(frame);
        layout.visible = true;
    }
    overlay::dispatch(
        app,
        Surface::Island,
        "mew:island-reset",
        &serde_json::json!({}),
    )
    .map_err(|_| "Couldn't reset Neb tools.")?;
    refresh(app)
}

pub fn shown(app: &AppHandle) -> bool {
    host(app).is_ok_and(|state| {
        state
            .layout
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .visible
    })
}

pub fn hide(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(Surface::Island.label()) {
        overlay::hide(&window).map_err(|_| "Couldn't hide Neb tools.")?;
    }
    host(app)?.layout.lock().unwrap_or_else(|p| p.into_inner()).visible = false;
    Ok(())
}

pub fn refresh(app: &AppHandle) -> Result<(), String> {
    let state = host(app)?;
    overlay::dispatch(
        app,
        Surface::Island,
        "mew:island-show",
        &serde_json::to_value(state.actions.view()).map_err(|_| "Couldn't show Neb tools.")?,
    )
    .map_err(|_| "Couldn't show Neb tools.".into())
}

fn fit(app: &AppHandle, height: f64) -> Result<(), String> {
    let state = host(app)?;
    let frame = {
        let mut layout = state.layout.lock().unwrap_or_else(|p| p.into_inner());
        let old = layout.frame.ok_or("Neb tools aren't open.")?;
        let display = target::display_at(target::Point {
            x: old.x + old.width / 2.,
            y: old.y,
        })
        .ok_or("The display changed.")?;
        let next = island_frame(
            display.points,
            safe_top(display.points).ok_or("The display changed.")?,
            height,
        )
        .ok_or("Couldn't size Neb tools.")?;
        layout.frame = Some(next);
        next
    };
    let window = app
        .get_webview_window(Surface::Island.label())
        .ok_or("Neb tools aren't open.")?;
    overlay::place(&window, frame).map_err(|_| "Couldn't size Neb tools.".into())
}

/// The page's local-only action. Operations queue on AppKit's main thread without making the
/// panel key; a host backend may start its own worker for slow capture/model work.
#[tauri::command]
pub fn screen_island(window: WebviewWindow, action: IslandAction) -> Result<(), String> {
    overlay::require_surface(&window, Surface::Island)?;
    let app = window.app_handle().clone();
    host(&app)?;
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if dispatch_action(&handle, action).is_err() {
            // Never send arbitrary upstream/native errors (which could contain content) to JS.
            let _ = overlay::dispatch(&handle, Surface::Island, "mew:island-notice",
                &serde_json::json!({"message": "That tool couldn't be used right now. Please try again."}));
        }
    }).map_err(|_| "Couldn't update Neb tools.".into())
}

fn dispatch_action(app: &AppHandle, action: IslandAction) -> Result<(), String> {
    let state = host(app)?;
    let backend = &state.actions;
    match action {
        IslandAction::Ready => {
            // Mac panels fit their content; keep tooltip labels inside the bar so an
            // invisible footer never intercepts clicks intended for the student's app.
            overlay::dispatch(app, Surface::Island, "mew:island-host",
                &serde_json::json!({"inlineTooltips": true}))
                .map_err(|_| "Couldn't configure Neb tools.")?;
        }
        IslandAction::Tool { tool } => backend.set_tool(backend.view().tool.toggled(tool))?,
        IslandAction::Shape { shape } => backend.set_shape(shape)?,
        IslandAction::Menu { open } => fit(
            app,
            if open {
                ISLAND_MENU_HEIGHT
            } else {
                ISLAND_SIZE.1
            },
        )?,
        IslandAction::Mic => backend.toggle_mic()?,
        IslandAction::Watch => backend.toggle_watch()?,
        IslandAction::Help { help } => backend.set_help(help)?,
        IslandAction::Clear => backend.clear()?,
        IslandAction::Close => {
            backend.close()?;
            let mut layout = state.layout.lock().unwrap_or_else(|p| p.into_inner());
            layout.visible = false;
            if let Some(window) = app.get_webview_window(Surface::Island.label()) {
                overlay::hide(&window).map_err(|_| "Couldn't close Neb tools.")?;
            }
            return Ok(());
        }
        IslandAction::MusicPanel { open, height } => {
            backend.music_panel(open)?;
            fit(
                app,
                if open {
                    crate::screen::island::music_height(height)
                } else {
                    ISLAND_SIZE.1
                },
            )?;
        }
        IslandAction::MusicControl { control } => backend.music_control(control)?,
        IslandAction::MusicPin => backend.music_pin()?,
        IslandAction::MusicOpen { id } => backend.music_open(&id)?,
        IslandAction::MusicUnpin { id } => backend.music_unpin(&id)?,
    }
    refresh(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fits_retina_left_display_without_scaling_global_origins() {
        let display = Rect::new(-1512., -200., 1512., 982.).unwrap();
        let frame = island_frame(display, 32., 58.).unwrap();
        assert_eq!(frame, Rect::new(-1166., -168., 820., 58.).unwrap());
    }
    #[test]
    fn avoids_notch_and_clamps_menu_to_small_displays() {
        let display = Rect::new(0., 0., 640., 400.).unwrap();
        let frame = island_frame(display, 32., 10000.).unwrap();
        assert_eq!(frame.width, 640.);
        assert_eq!(frame.height, 368.);
        assert!(island_frame(display, f64::NAN, 58.).is_none());
        assert!(island_frame(display, 401., 58.).is_none());
    }
}
