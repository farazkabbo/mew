//! The island: a small black bar at the top of the screen, like a Mac's Dynamic Island, holding
//! Screen Coach's tools so nothing needs a shortcut (double-tap Ctrl+Alt shows or hides it).
//! From left to right: what Neb is doing (listening, looking, thinking, speaking), the pen and
//! eraser (the student's own notes on the screen, never sent anywhere), the select tool with its
//! shapes (freehand, rectangle, ellipse: the area Neb looks at, as Circle & Ask marks), the
//! microphone (on, speak, off: then Neb answers), music (what's playing and pinned playlists:
//! `music.rs`), Clear and Close.
//!
//! Pure: what the tools are, where the bar goes, the paths of the select shapes, and the view
//! the bar's page is sent. The windows and buttons are `screen_island.rs`.

use serde::{Deserialize, Serialize};

use super::frame::ScreenRect;
use super::marks::Pt;

/// The island's bar in CSS pixels, and its height with the shapes menu open below the tools.
/// Like a Mac's notch it hangs from the top edge of the screen.
pub const ISLAND_SIZE: (f64, f64) = (520.0, 58.0);
pub const ISLAND_MENU_HEIGHT: f64 = 110.0;
/// The tallest the music panel makes the island (six pins, a notice and the pin button).
pub const ISLAND_MUSIC_HEIGHT: f64 = 460.0;
/// The island's window is always this tall (the page draws the island in its top part).
pub const ISLAND_WINDOW_HEIGHT: f64 = ISLAND_MUSIC_HEIGHT;

/// The island's height with the music panel open, from what its page measured (CSS pixels).
pub fn music_height(measured: u32) -> f64 {
    f64::from(measured).clamp(ISLAND_SIZE.1, ISLAND_MUSIC_HEIGHT)
}
/// Its shape (a notch with ears where it meets the top edge, round bottom corners) is drawn by
/// its page, smooth; the window itself is transparent around it.
/// Points along each side of a rectangle, and around an ellipse (a select shape's path).
const SIDE_POINTS: usize = 12;
const ELLIPSE_POINTS: usize = 48;

/// What a drag on the screen does.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    /// The mouse goes to the student's apps.
    #[default]
    None,
    /// Draws the student's own notes on the screen.
    Pen,
    /// Rubs out the student's notes.
    Eraser,
    /// Marks the area Neb looks at (Circle & Ask).
    Select,
}

impl Tool {
    /// Draw mode is on: the draw overlay takes the mouse, pen and touch.
    pub fn draws(self) -> bool {
        self != Tool::None
    }

    /// The pen and eraser work on the student's own notes, not on marks.
    pub fn annotates(self) -> bool {
        matches!(self, Tool::Pen | Tool::Eraser)
    }

    /// Clicking a tool that's on turns it off.
    pub fn toggled(self, clicked: Tool) -> Tool {
        if self == clicked {
            Tool::None
        } else {
            clicked
        }
    }
}

/// The shape a select drag makes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Shape {
    /// Whatever the student draws (a circle, an underline, an arrow, a tap).
    #[default]
    Free,
    /// A box from where the drag began to where it ended.
    Rect,
    /// An ellipse inside that box.
    Ellipse,
}

/// A select drag's points as the mark it makes: unchanged when freehand, else the closed outline
/// of the box (or ellipse) from its first point to its last. None for a drag too small to be a
/// shape (a slip: it stays a tap).
pub fn shape_path(shape: Shape, points: &[Pt]) -> Option<Vec<Pt>> {
    let (&first, &last) = (points.first()?, points.last()?);
    if shape == Shape::Free {
        return Some(points.to_vec());
    }
    let (left, right) = (first.0.min(last.0), first.0.max(last.0));
    let (top, bottom) = (first.1.min(last.1), first.1.max(last.1));
    if right - left < 4.0 || bottom - top < 4.0 {
        return None;
    }
    Some(match shape {
        Shape::Free => unreachable!(),
        Shape::Rect => {
            let corners = [
                (left, top),
                (right, top),
                (right, bottom),
                (left, bottom),
                (left, top),
            ];
            let mut path: Vec<Pt> = corners
                .windows(2)
                .flat_map(|side| {
                    let ((x0, y0), (x1, y1)) = (side[0], side[1]);
                    (0..SIDE_POINTS).map(move |k| {
                        let t = k as f32 / SIDE_POINTS as f32;
                        (x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
                    })
                })
                .collect();
            path.push((left, top));
            path
        }
        Shape::Ellipse => {
            let (cx, cy) = ((left + right) / 2.0, (top + bottom) / 2.0);
            let (rx, ry) = ((right - left) / 2.0, (bottom - top) / 2.0);
            (0..=ELLIPSE_POINTS)
                .map(|k| {
                    let t = k as f32 / ELLIPSE_POINTS as f32 * std::f32::consts::TAU;
                    (cx + rx * t.cos(), cy + ry * t.sin())
                })
                .collect()
        }
    })
}

/// Where the bar goes: centred at the top of `monitor` (physical pixels), `height` CSS pixels
/// tall (the bar, or the bar with its menu open).
pub fn island_spot(monitor: ScreenRect, scale: f64, height: f64) -> ScreenRect {
    let w = ((ISLAND_SIZE.0 * scale).round() as i32).min(monitor.width());
    let h = ((height * scale).round() as i32).min(monitor.height());
    let left = monitor.left + (monitor.width() - w) / 2;
    let top = monitor.top;
    ScreenRect {
        left,
        top,
        right: left + w,
        bottom: top + h,
    }
}

/// How far a scrolled view has moved, in pixels, from UI Automation's scroll pattern: `percent`
/// of the way through (0–100; negative means it can't scroll that way), `view_size` the share of
/// the content on show (0–100), across a viewport `viewport` pixels long. The student's pen notes
/// move by the change, so they stay on what they were written on.
pub fn scroll_offset(percent: f64, view_size: f64, viewport: f64) -> f64 {
    if !(percent >= 0.0 && view_size > 0.0 && view_size < 100.0 && viewport > 0.0) {
        return 0.0;
    }
    let content = viewport * 100.0 / view_size;
    percent / 100.0 * (content - viewport)
}

/// What Neb is doing, as the bar shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Activity {
    Ready,
    Listening,
    Looking,
    Thinking,
    Speaking,
    Paused,
}

/// What the bar's page is sent (`mew:island-show`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IslandView {
    pub tool: Tool,
    pub shape: Shape,
    /// The microphone is on (listening for the question).
    pub mic: bool,
    /// Voice is off in the settings (silent mode): the mic button can't be used.
    pub silent: bool,
    pub activity: Activity,
    /// The student has notes on the screen, or marks: Clear has something to clear.
    pub clearable: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tool_clicked_again_turns_off() {
        assert_eq!(Tool::None.toggled(Tool::Pen), Tool::Pen);
        assert_eq!(Tool::Pen.toggled(Tool::Pen), Tool::None);
        assert_eq!(Tool::Pen.toggled(Tool::Select), Tool::Select);
        assert!(Tool::Eraser.annotates() && !Tool::Select.annotates());
        assert!(!Tool::None.draws() && Tool::Select.draws());
    }

    #[test]
    fn a_rectangle_is_the_closed_box_from_the_first_point_to_the_last() {
        let drag = [(300.0, 200.0), (150.0, 90.0), (100.0, 120.0)];
        let path = shape_path(Shape::Rect, &drag).unwrap();
        assert_eq!(path.first(), Some(&(100.0, 120.0)));
        assert_eq!(path.last(), path.first(), "closed");
        let xs = path.iter().map(|p| p.0);
        let ys = path.iter().map(|p| p.1);
        assert_eq!(xs.clone().fold(f32::MAX, f32::min), 100.0);
        assert_eq!(xs.fold(f32::MIN, f32::max), 300.0);
        assert_eq!(ys.clone().fold(f32::MAX, f32::min), 120.0);
        assert_eq!(ys.fold(f32::MIN, f32::max), 200.0);
    }

    #[test]
    fn an_ellipse_fits_inside_the_box_and_closes() {
        let path = shape_path(Shape::Ellipse, &[(0.0, 0.0), (200.0, 100.0)]).unwrap();
        assert!(path.iter().all(|&(x, y)| {
            let (dx, dy) = ((x - 100.0) / 100.0, (y - 50.0) / 50.0);
            (dx * dx + dy * dy - 1.0).abs() < 1e-3
        }));
        let (a, b) = (path[0], path[path.len() - 1]);
        assert!((a.0 - b.0).abs() < 1e-3 && (a.1 - b.1).abs() < 1e-3);
    }

    #[test]
    fn freehand_is_unchanged_and_a_slip_makes_no_shape() {
        let drag = vec![(1.0, 1.0), (50.0, 60.0)];
        assert_eq!(shape_path(Shape::Free, &drag), Some(drag));
        assert_eq!(shape_path(Shape::Rect, &[(10.0, 10.0), (12.0, 40.0)]), None);
        assert_eq!(shape_path(Shape::Ellipse, &[]), None);
    }

    #[test]
    fn the_bar_sits_centred_at_the_top_of_its_monitor() {
        let monitor = ScreenRect {
            left: -2880,
            top: 0,
            right: 0,
            bottom: 1620,
        };
        let spot = island_spot(monitor, 1.5, ISLAND_SIZE.1);
        assert_eq!(spot.width(), 780);
        assert_eq!(spot.height(), 87);
        assert_eq!(spot.top, 0, "it hangs from the top edge");
        assert_eq!(spot.left - monitor.left, monitor.right - spot.right);
        // The menu makes it taller, from the same top.
        let open = island_spot(monitor, 1.5, ISLAND_MENU_HEIGHT);
        assert_eq!((open.top, open.left), (spot.top, spot.left));
        assert_eq!(open.height(), 165);
    }

    #[test]
    fn the_music_panel_is_never_shorter_than_the_bar_or_taller_than_the_window() {
        assert_eq!(music_height(300), 300.0);
        assert_eq!(music_height(0), ISLAND_SIZE.1);
        assert_eq!(music_height(u32::MAX), ISLAND_MUSIC_HEIGHT);
        const { assert!(ISLAND_WINDOW_HEIGHT >= ISLAND_MENU_HEIGHT) };
    }

    #[test]
    fn scrolling_is_measured_in_pixels() {
        // A 1000 px window showing a quarter of a 4000 px page, halfway down: 1500 px in.
        assert_eq!(scroll_offset(50.0, 25.0, 1000.0), 1500.0);
        assert_eq!(scroll_offset(0.0, 25.0, 1000.0), 0.0);
        // Can't scroll that way, or everything is on show: nothing moves.
        assert_eq!(scroll_offset(-1.0, 25.0, 1000.0), 0.0);
        assert_eq!(scroll_offset(30.0, 100.0, 1000.0), 0.0);
        assert_eq!(scroll_offset(f64::NAN, 25.0, 1000.0), 0.0);
    }

    #[test]
    fn the_view_is_what_the_page_expects() {
        let view = IslandView {
            tool: Tool::Select,
            shape: Shape::Ellipse,
            mic: true,
            silent: false,
            activity: Activity::Listening,
            clearable: false,
        };
        assert_eq!(
            serde_json::to_value(&view).unwrap(),
            serde_json::json!({
                "tool": "select", "shape": "ellipse", "mic": true, "silent": false,
                "activity": "listening", "clearable": false
            })
        );
    }
}
