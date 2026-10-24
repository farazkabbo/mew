//! The tutor pointer (Circle & Ask, docs/SCREEN_COACH_S3_2.md §2.1): a small Mew mark riding
//! beside the cursor. Pure: where it goes, when it shows, and how often the tracker looks.
//!
//! The pointer only follows the cursor's position (decision 11): no clicks, no keys, no history.

use serde::{Deserialize, Serialize};

use super::frame::ScreenRect;

/// "Show pointer" (brief §2.1).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerShow {
    #[default]
    Always,
    WhileDrawing,
    Never,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerSize {
    Small,
    #[default]
    Medium,
    Large,
}

impl PointerSize {
    /// Its side, in CSS pixels.
    pub fn css(self) -> f64 {
        match self {
            PointerSize::Small => 24.0,
            PointerSize::Medium => 32.0,
            PointerSize::Large => 44.0,
        }
    }
}

/// Which side of the cursor it sits on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Corner {
    #[default]
    BottomRight,
    BottomLeft,
    TopRight,
    TopLeft,
}

/// What the pointer shows (its page draws each look).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerLook {
    Idle,
    /// Draw mode is on: a pen tip (brief §7.3: shown whenever input is captured).
    Drawing,
    Listening,
    Thinking,
    Explaining,
    /// This app can't be looked at (blocked, a password field…).
    Blocked,
}

/// How far from the cursor the pointer's near corner is, in CSS pixels (brief: about 28).
const OFFSET_CSS: f64 = 28.0;

/// Where the pointer goes for a cursor at `cursor` (screen pixels), kept on `monitor`.
pub fn pointer_spot(
    cursor: (i32, i32),
    size: PointerSize,
    corner: Corner,
    scale: f64,
    monitor: ScreenRect,
) -> ScreenRect {
    let side = (size.css() * scale).round() as i32;
    let offset = (OFFSET_CSS * scale).round() as i32;
    let (dx, dy) = match corner {
        Corner::BottomRight => (offset - side / 2, offset - side / 2),
        Corner::BottomLeft => (-offset - side / 2, offset - side / 2),
        Corner::TopRight => (offset - side / 2, -offset - side / 2),
        Corner::TopLeft => (-offset - side / 2, -offset - side / 2),
    };
    let left = (cursor.0 + dx).clamp(monitor.left, (monitor.right - side).max(monitor.left));
    let top = (cursor.1 + dy).clamp(monitor.top, (monitor.bottom - side).max(monitor.top));
    ScreenRect {
        left,
        top,
        right: left + side,
        bottom: top + side,
    }
}

/// Why the pointer stays hidden whatever the setting (brief §2.1).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Hide {
    /// Screen Coach is off or paused.
    pub off: bool,
    /// A full-screen app (a game, a video) is in front.
    pub fullscreen: bool,
    /// A call or screen share is going on (the existing auto-pause).
    pub in_call: bool,
    /// The app in front is on the blocked list.
    pub blocked_app: bool,
}

/// Whether the pointer shows right now.
pub fn shows(setting: PointerShow, drawing: bool, hide: Hide) -> bool {
    if hide.off || hide.fullscreen || hide.in_call {
        return false;
    }
    match setting {
        // While drawing it always shows (the pen tip says input is being taken), even in a
        // blocked app (where it shows why nothing will be looked at).
        _ if drawing => true,
        PointerShow::Always => !hide.blocked_app,
        PointerShow::WhileDrawing | PointerShow::Never => false,
    }
}

/// How long the tracker sleeps between looks (decision 11): a frame while the cursor moves or
/// draw mode is on, a tenth of a second otherwise.
pub fn tick_ms(moved_recently: bool, drawing: bool) -> u64 {
    if moved_recently || drawing {
        16
    } else {
        100
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: ScreenRect = ScreenRect {
        left: -1920,
        top: 0,
        right: 0,
        bottom: 1080,
    };

    #[test]
    fn rides_beside_the_cursor_and_stays_on_the_monitor() {
        let spot = pointer_spot(
            (-1000, 500),
            PointerSize::Medium,
            Corner::BottomRight,
            1.5,
            MONITOR,
        );
        // 32 CSS px at 150 % = 48; its centre 42 px (28 CSS) down-right of the cursor.
        assert_eq!((spot.width(), spot.height()), (48, 48));
        assert_eq!(
            ((spot.left + spot.right) / 2, (spot.top + spot.bottom) / 2),
            (-958, 542)
        );
        let left = pointer_spot(
            (-1000, 500),
            PointerSize::Small,
            Corner::TopLeft,
            1.0,
            MONITOR,
        );
        assert!(left.right < -1000 && left.bottom < 500);
        // At the monitor's bottom-right corner it's pushed back inside.
        let corner = pointer_spot(
            (-1, 1079),
            PointerSize::Large,
            Corner::BottomRight,
            2.0,
            MONITOR,
        );
        assert_eq!((corner.right, corner.bottom), (0, 1080));
    }

    #[test]
    fn hides_when_it_should() {
        let none = Hide::default();
        assert!(shows(PointerShow::Always, false, none));
        assert!(!shows(PointerShow::WhileDrawing, false, none));
        assert!(shows(PointerShow::WhileDrawing, true, none));
        assert!(
            shows(PointerShow::Never, true, none),
            "the pen tip shows when drawing"
        );
        assert!(!shows(PointerShow::Never, false, none));
        for hide in [
            Hide { off: true, ..none },
            Hide {
                fullscreen: true,
                ..none
            },
            Hide {
                in_call: true,
                ..none
            },
        ] {
            assert!(!shows(PointerShow::Always, true, hide), "{hide:?}");
        }
        let blocked = Hide {
            blocked_app: true,
            ..none
        };
        assert!(!shows(PointerShow::Always, false, blocked));
        assert!(shows(PointerShow::Always, true, blocked));
    }

    #[test]
    fn looks_often_only_while_something_happens() {
        assert_eq!(tick_ms(true, false), 16);
        assert_eq!(tick_ms(false, true), 16);
        assert_eq!(tick_ms(false, false), 100);
    }
}
