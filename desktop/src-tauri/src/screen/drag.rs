//! A mouse drag read by polling (Circle & Ask): the tracker looks at the primary button and the
//! cursor every few milliseconds while draw mode (or "select question") is on, and this turns
//! those looks into strokes.
//!
//! Why not the overlay page's pointer events? A transparent, never-activated window's webview
//! doesn't reliably get the mouse on Windows, and drawing has to work wherever the student
//! holds the keys. Pen and touch still come from the page (they report pressure); the page
//! ignores the mouse.
//!
//! Pure: no Windows calls, so it's tested on every platform.

use super::marks::Pt;

/// A stroke stops growing here (the overlay page's limit too).
pub const MAX_POINTS: usize = 5_000;
/// Points closer than this to the last one (screen pixels) add nothing.
const MIN_STEP: f32 = 1.0;

/// What one look changed.
#[derive(Debug, Clone, PartialEq)]
pub enum DragLook {
    /// Nothing new.
    Idle,
    /// A drag began at this point.
    Started(Pt),
    /// The drag went on to this point.
    Moved(Pt),
    /// The button came up: the whole stroke.
    Finished(Vec<Pt>),
}

#[derive(Debug, Default)]
pub struct Drag {
    /// The stroke while the button is down.
    points: Option<Vec<Pt>>,
    /// The button was down at the last look. A drag only starts on a fresh press, so a button
    /// already held when draw mode came on (a drag in the student's app) never becomes a mark.
    was_down: bool,
}

impl Drag {
    /// A drag reader for draw mode that just came on, with the button as it is now.
    pub fn new(down: bool) -> Self {
        Self {
            points: None,
            was_down: down,
        }
    }

    /// Whether a stroke is being drawn.
    pub fn active(&self) -> bool {
        self.points.is_some()
    }

    /// Where the stroke began.
    pub fn first(&self) -> Option<Pt> {
        self.points
            .as_ref()
            .and_then(|points| points.first().copied())
    }

    /// One look at the button and the cursor (screen pixels).
    pub fn look(&mut self, down: bool, at: Pt) -> DragLook {
        let pressed = down && !self.was_down;
        self.was_down = down;
        match (self.points.as_mut(), down) {
            (None, true) if pressed => {
                self.points = Some(vec![at]);
                DragLook::Started(at)
            }
            (Some(points), true) => {
                let far_enough = points
                    .last()
                    .is_none_or(|&(x, y)| (at.0 - x).hypot(at.1 - y) >= MIN_STEP);
                if far_enough && points.len() < MAX_POINTS {
                    points.push(at);
                    DragLook::Moved(at)
                } else {
                    DragLook::Idle
                }
            }
            (Some(_), false) => DragLook::Finished(self.points.take().unwrap_or_default()),
            _ => DragLook::Idle,
        }
    }

    /// Draw mode went off mid-stroke: the stroke is dropped.
    pub fn cancel(&mut self) {
        self.points = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_press_drag_and_release_is_one_stroke() {
        let mut drag = Drag::new(false);
        assert_eq!(drag.look(false, (0.0, 0.0)), DragLook::Idle);
        assert_eq!(
            drag.look(true, (10.0, 10.0)),
            DragLook::Started((10.0, 10.0))
        );
        assert!(drag.active());
        assert_eq!(drag.look(true, (20.0, 10.0)), DragLook::Moved((20.0, 10.0)));
        assert_eq!(
            drag.look(false, (30.0, 10.0)),
            DragLook::Finished(vec![(10.0, 10.0), (20.0, 10.0)])
        );
        assert!(!drag.active());
    }

    #[test]
    fn a_button_held_before_draw_mode_never_draws() {
        let mut drag = Drag::new(true);
        assert_eq!(drag.look(true, (5.0, 5.0)), DragLook::Idle);
        assert_eq!(drag.look(true, (50.0, 5.0)), DragLook::Idle);
        assert_eq!(drag.look(false, (50.0, 5.0)), DragLook::Idle);
        // The next press is a fresh one.
        assert_eq!(drag.look(true, (1.0, 1.0)), DragLook::Started((1.0, 1.0)));
    }

    #[test]
    fn a_still_cursor_adds_no_points() {
        let mut drag = Drag::new(false);
        drag.look(true, (0.0, 0.0));
        assert_eq!(drag.look(true, (0.5, 0.0)), DragLook::Idle);
        assert_eq!(
            drag.look(false, (0.5, 0.0)),
            DragLook::Finished(vec![(0.0, 0.0)])
        );
    }

    #[test]
    fn a_stroke_stops_growing_at_the_limit() {
        let mut drag = Drag::new(false);
        drag.look(true, (0.0, 0.0));
        for i in 1..(MAX_POINTS + 100) {
            drag.look(true, (i as f32 * 2.0, 0.0));
        }
        let DragLook::Finished(points) = drag.look(false, (0.0, 0.0)) else {
            panic!("the release finishes the stroke");
        };
        assert_eq!(points.len(), MAX_POINTS);
    }

    #[test]
    fn cancelling_drops_the_stroke() {
        let mut drag = Drag::new(false);
        drag.look(true, (0.0, 0.0));
        drag.cancel();
        assert_eq!(drag.look(false, (0.0, 0.0)), DragLook::Idle);
    }
}
