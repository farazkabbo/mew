//! The island on screen (`island.rs` has what it is): a black bar at the top centre of the
//! monitor under the cursor, shown and hidden by a double tap of Ctrl+Alt. Like the progress
//! pill it's clickable but never takes the focus (the student's app stays active), and it's
//! excluded from captures, so Neb never sees it. Its page sends one command, `screen_island`,
//! with the button pressed; Rust sends back the view after every change.

use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use super::circle::{self, Stage};
use super::coach::{self, ScreenCoach};
use super::frame::ScreenRect;
use super::island::{
    island_spot, music_height, Activity, IslandView, Shape, Tool, ISLAND_MENU_HEIGHT, ISLAND_SIZE,
    ISLAND_WINDOW_HEIGHT,
};
use super::music::Control;
use super::overlay::{self, require_surface, Surface};
use super::screen_music;
use super::tray_badge::Status;
use super::win::{input, target};

const ISLAND_SHOW: &str = "mew:island-show";
/// A press on the island that Rust saw (CSS pixels of the island's page).
const ISLAND_PRESS: &str = "mew:island-press";
/// The island is showing again: its menu and music panel start closed.
const ISLAND_RESET: &str = "mew:island-reset";

/// Whether the island is showing.
pub fn shown<R: Runtime>(app: &AppHandle<R>) -> bool {
    circle::state(app).is_some_and(|s| s.island.is_some())
}

/// The double tap: shows the island on the monitor under the cursor, or hides it.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    if shown(app) {
        hide(app);
    } else {
        show(app);
    }
}

fn show<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = overlay::ensure(app, Surface::Island) else {
        return;
    };
    let Some((monitor, dpi)) = input::cursor().and_then(|(x, y)| target::monitor_at(x, y)) else {
        return;
    };
    let scale = f64::from(dpi.max(96)) / 96.0;
    // The window is always tall enough for the menu and the music panel (and the buttons' names
    // on hover): the page draws the island in its top part and leaves the rest clear, so the
    // window never resizes (resizing it showed a pale band). Clicks on the clear part reach the
    // app below.
    let window_rect = island_spot(monitor, scale, ISLAND_WINDOW_HEIGHT);
    let island = island_spot(monitor, scale, ISLAND_SIZE.1);
    if let Some(mut state) = circle::state(app) {
        state.island = Some(island);
    }
    overlay::dispatch(app, Surface::Island, ISLAND_RESET, &serde_json::json!({}));
    shape(&window, window_rect);
    keep_island_only(&window, island, scale);
    circle::start_tracker(app);
    refresh(app);
    screen_music::start(app);
}

/// Hides the island: its tool goes off, the microphone stops without asking, and the student's
/// notes and marks are cleared (they were made with it).
pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(mut state) = circle::state(app) {
        state.island = None;
    }
    if coach::mic_on(app) {
        coach::mic_cancel(app);
    }
    circle::set_tool(app, Tool::None);
    circle::clear_all(app);
    overlay::hide_quietly_named(app, Surface::Island);
}

/// Places the island at `rect` (its page draws the shape to fill it) and takes the clicks.
fn shape<R: Runtime>(window: &WebviewWindow<R>, rect: ScreenRect) {
    overlay::place(window, rect);
    overlay::drop_frame(window);
    overlay::set_click_through(window, false);
    overlay::show_filled(window, rect);
}

/// The mouse went down on the island at (`x`, `y`) (screen pixels) while draw mode was on: the
/// page clicks the button there (unless it saw the click itself).
pub fn press<R: Runtime>(app: &AppHandle<R>, x: i32, y: i32) {
    let Some(rect) = circle::state(app).and_then(|s| s.island) else {
        return;
    };
    let Some((_, dpi)) = target::monitor_at(x, y) else {
        return;
    };
    let scale = f64::from(dpi.max(96)) / 96.0;
    overlay::dispatch(
        app,
        Surface::Island,
        ISLAND_PRESS,
        &serde_json::json!({
            "x": f64::from(x - rect.left) / scale,
            "y": f64::from(y - rect.top) / scale,
        }),
    );
}

/// Puts the island back on top (the draw overlay, shown after it, would cover its buttons).
pub fn raise<R: Runtime>(app: &AppHandle<R>) {
    if !shown(app) {
        return;
    }
    let Some(window) = app.get_webview_window(Surface::Island.label()) else {
        return;
    };
    // Not `show_quietly`: when the title bar has crept back, taking it off again must be followed
    // by a resize, or a pale band shows along the island's top (seen as a tool came on).
    let (Ok(at), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let rect = ScreenRect {
        left: at.x,
        top: at.y,
        right: at.x + size.width as i32,
        bottom: at.y + size.height as i32,
    };
    overlay::show_filled(&window, rect);
}

/// Sends the island what to show now (after any change to the tools, the mic or Neb's status).
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    coach::refresh_frame(app);
    if !shown(app) {
        return;
    }
    let (tool, shape) = circle::tool(app);
    let status = app
        .try_state::<ScreenCoach>()
        .map_or(Status::Idle, |coach| coach.view().status);
    let answering = circle::with_session(app, |s| s.stage == Stage::Answering).unwrap_or(false);
    let view = IslandView {
        tool,
        shape,
        mic: coach::mic_on(app),
        silent: coach::circle_settings(app).silent,
        activity: activity(status, answering),
        clearable: circle::clearable(app),
    };
    if let Ok(view) = serde_json::to_value(&view) {
        overlay::dispatch(app, Surface::Island, ISLAND_SHOW, &view);
    }
}

fn activity(status: Status, answering: bool) -> Activity {
    match status {
        Status::Listening => Activity::Listening,
        Status::Looking => Activity::Looking,
        Status::Speaking => Activity::Speaking,
        Status::Paused => Activity::Paused,
        _ if answering => Activity::Thinking,
        _ => Activity::Ready,
    }
}

/// A button on the island.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IslandAction {
    /// The pen, the eraser or select (clicked again: off).
    Tool {
        tool: Tool,
    },
    /// A shape from select's menu (select comes on with it).
    Shape {
        shape: Shape,
    },
    /// The shapes menu opened or closed: the window grows to fit it.
    Menu {
        open: bool,
    },
    Mic,
    Clear,
    Close,
    /// The music panel opened (`height`: the island's height with it, measured by the page) or
    /// closed.
    MusicPanel {
        open: bool,
        height: u32,
    },
    /// Play/pause, next or previous on what's playing.
    MusicControl {
        control: Control,
    },
    /// Pin the playlist whose link is on the clipboard.
    MusicPin,
    /// Open a pinned playlist, or unpin it (its Spotify id).
    MusicOpen {
        id: String,
    },
    MusicUnpin {
        id: String,
    },
}

#[tauri::command(async)]
pub fn screen_island<R: Runtime>(
    window: WebviewWindow<R>,
    action: IslandAction,
) -> Result<(), String> {
    require_surface(&window, Surface::Island)?;
    let app = window.app_handle();
    if !coach::is_usable(app) {
        hide(app);
        return Ok(());
    }
    match action {
        IslandAction::Tool { tool } => {
            let (current, _) = circle::tool(app);
            circle::set_tool(app, current.toggled(tool));
        }
        IslandAction::Shape { shape } => {
            circle::set_shape(app, shape);
            circle::set_tool(app, Tool::Select);
        }
        IslandAction::Menu { open } => fit(
            app,
            if open {
                ISLAND_MENU_HEIGHT
            } else {
                ISLAND_SIZE.1
            },
        ),
        IslandAction::Mic => coach::toggle_mic(app),
        IslandAction::Clear => circle::clear_all(app),
        IslandAction::Close => {
            hide(app);
            return Ok(());
        }
        IslandAction::MusicPanel { open, height } => {
            fit(
                app,
                if open {
                    music_height(height)
                } else {
                    ISLAND_SIZE.1
                },
            );
            return Ok(());
        }
        IslandAction::MusicControl { control } => {
            screen_music::control(app, control);
            return Ok(());
        }
        IslandAction::MusicPin => {
            screen_music::pin(app);
            return Ok(());
        }
        IslandAction::MusicOpen { id } => {
            screen_music::open(app, &id);
            return Ok(());
        }
        IslandAction::MusicUnpin { id } => {
            screen_music::unpin(app, &id);
            return Ok(());
        }
    }
    refresh(app);
    Ok(())
}

/// Where the island is drawn (the bar, or the bar with its menu or music panel open, `height`
/// CSS pixels): presses there are clicks on it, never strokes. The window itself stays the same.
fn fit<R: Runtime>(app: &AppHandle<R>, height: f64) {
    let Some(rect) = circle::state(app).and_then(|s| s.island) else {
        return;
    };
    let Some((monitor, dpi)) = target::monitor_at(rect.left + rect.width() / 2, rect.top) else {
        return;
    };
    let scale = f64::from(dpi.max(96)) / 96.0;
    let next = island_spot(monitor, scale, height);
    if let Some(mut state) = circle::state(app) {
        state.island = Some(next);
    }
    if let Some(window) = app.get_webview_window(Surface::Island.label()) {
        keep_island_only(&window, next, scale);
    }
    circle::island_changed(app);
}

/// The room under the island for a button's name (CSS pixels).
const TIP_ROOM: f64 = 40.0;

/// Cuts the window down to the island and the names under its buttons, so a pen reaches whatever
/// is under the rest of it.
fn keep_island_only<R: Runtime>(window: &WebviewWindow<R>, island: ScreenRect, scale: f64) {
    let room = (TIP_ROOM * scale).round() as i32;
    overlay::keep_top(window, island.width(), island.height() + room);
}
