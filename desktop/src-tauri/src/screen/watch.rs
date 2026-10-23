//! Deciding when on-screen ink no longer matches the screen (S3 §2.3, decision 9). The Windows
//! hooks that feed these live in `win/winevent.rs`; the decisions are here, pure and tested.
//!
//! Ink fades when the content under it may have moved: the window moved, resized, minimised or
//! lost the foreground; the mouse wheel turned; a drag with the left button (a scrollbar, a
//! selection); or a key was pressed (Page Down, arrows, typing). Plain mouse movement and clicks
//! don't count, and neither do our own hotkeys (Ctrl/Alt chords).

use std::time::{Duration, Instant};

/// Why the ink faded (for the log: never which keys or where).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Moved,
    Minimised,
    SwitchedApp,
    Closed,
    Scrolled,
    Dragged,
    Typed,
}

/// Mouse events as the low-level hook sees them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mouse {
    Move { x: i32, y: i32 },
    LeftDown { x: i32, y: i32 },
    LeftUp,
    Wheel,
}

/// How far the mouse may travel with the left button down and still be a click.
const DRAG_PX: i32 = 8;

/// Turns the mouse hook's events into "the content may have scrolled".
#[derive(Debug, Default)]
pub struct MouseJudge {
    down_at: Option<(i32, i32)>,
}

impl MouseJudge {
    pub fn on(&mut self, event: Mouse) -> Option<Change> {
        match event {
            Mouse::Wheel => Some(Change::Scrolled),
            Mouse::LeftDown { x, y } => {
                self.down_at = Some((x, y));
                None
            }
            Mouse::LeftUp => {
                self.down_at = None;
                None
            }
            Mouse::Move { x, y } => {
                let (x0, y0) = self.down_at?;
                if (x - x0).abs() > DRAG_PX || (y - y0).abs() > DRAG_PX {
                    self.down_at = None;
                    Some(Change::Dragged)
                } else {
                    None
                }
            }
        }
    }
}

/// After Ctrl or Alt was last seen held, key input this soon after is still that chord (the
/// keys of a hotkey come up one by one).
const CHORD_TAIL: Duration = Duration::from_millis(600);

/// Spots key presses without a keyboard hook: Windows' last-input time moved, and the mouse
/// didn't account for it.
#[derive(Debug, Default)]
pub struct KeyJudge {
    last_tick: Option<u32>,
    chord_until: Option<Instant>,
}

impl KeyJudge {
    /// Called on every poll with Windows' last-input tick, whether the mouse hook saw anything
    /// since the last poll, and whether Ctrl, Alt or the Windows key is held right now.
    pub fn poll(
        &mut self,
        now: Instant,
        tick: u32,
        mouse_since_last: bool,
        modifier_down: bool,
    ) -> Option<Change> {
        let previous = self.last_tick.replace(tick);
        if modifier_down {
            self.chord_until = Some(now + CHORD_TAIL);
        }
        let changed = previous.is_some_and(|p| p != tick);
        let in_chord = modifier_down || self.chord_until.is_some_and(|until| now < until);
        (changed && !mouse_since_last && !in_chord).then_some(Change::Typed)
    }
}

/// Whether a foreground change means the student left the app the ink is about. Our own windows
/// (the ink pill, a clip's preview) never count: Windows doesn't report them to the hook.
pub fn left_target(new_foreground_root: isize, target: isize) -> bool {
    new_foreground_root != 0 && new_foreground_root != target
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wheel_and_drags_count_but_moves_and_clicks_dont() {
        let mut judge = MouseJudge::default();
        assert_eq!(judge.on(Mouse::Move { x: 0, y: 0 }), None);
        assert_eq!(judge.on(Mouse::Move { x: 500, y: 500 }), None);
        assert_eq!(judge.on(Mouse::LeftDown { x: 10, y: 10 }), None);
        assert_eq!(judge.on(Mouse::Move { x: 13, y: 12 }), None, "a shaky click");
        assert_eq!(judge.on(Mouse::LeftUp), None);
        assert_eq!(judge.on(Mouse::Move { x: 40, y: 40 }), None, "button already up");
        assert_eq!(judge.on(Mouse::LeftDown { x: 10, y: 10 }), None);
        assert_eq!(
            judge.on(Mouse::Move { x: 10, y: 40 }),
            Some(Change::Dragged)
        );
        assert_eq!(judge.on(Mouse::Wheel), Some(Change::Scrolled));
    }

    #[test]
    fn key_presses_count_but_not_our_hotkeys_or_the_mouse() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut judge = KeyJudge::default();
        assert_eq!(judge.poll(at(0), 100, false, false), None, "first poll");
        assert_eq!(judge.poll(at(50), 100, false, false), None, "no input");
        assert_eq!(judge.poll(at(100), 140, true, false), None, "the mouse moved");
        assert_eq!(
            judge.poll(at(150), 190, false, false),
            Some(Change::Typed),
            "a key"
        );

        // Ctrl+Alt+C: input while Ctrl/Alt are held, then the keys come up one by one.
        assert_eq!(judge.poll(at(200), 250, false, true), None);
        assert_eq!(judge.poll(at(250), 300, false, false), None, "C released");
        assert_eq!(judge.poll(at(700), 350, false, false), None, "Alt released");
        assert_eq!(
            judge.poll(at(900), 420, false, false),
            Some(Change::Typed),
            "a real key after the chord"
        );
    }

    #[test]
    fn switching_away_counts_but_coming_back_doesnt() {
        assert!(left_target(0x2000, 0x1000));
        assert!(!left_target(0x1000, 0x1000));
        assert!(!left_target(0, 0x1000), "no foreground window (desktop switching)");
    }
}
