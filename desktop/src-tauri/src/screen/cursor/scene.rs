//! What the cursor layer draws (D), as plain data: the renderer (`win/cursor_layer.rs`) turns a
//! `Scene` into Direct2D calls, and everything about where and how big is decided here, where it
//! can be tested. Coordinates are global physical pixels; the renderer offsets them per monitor.

use crate::screen::frame::ScreenRect;

#[derive(Debug, Clone, PartialEq)]
pub enum Shape {
    /// A soft curved line from the cursor to the next target (SHOW ME).
    GhostPath {
        from: (f64, f64),
        control: (f64, f64),
        to: (f64, f64),
        alpha: f32,
    },
    /// A glow around a target, scaled about its centre (1.0 = its own size, up to ~1.6).
    Glow {
        rect: ScreenRect,
        scale: f32,
        alpha: f32,
        /// A warning (CATCH ME) is amber, guidance violet.
        warn: bool,
    },
    /// A small rounded caption, its top-left corner at `at`.
    Caption {
        at: (f64, f64),
        text: String,
        warn: bool,
        /// The monitor's scaling (1.0 at 96 DPI): the chip and its text grow with it.
        scale: f32,
    },
    /// A dot (the ghost cursor in a replay, or the debug view's predicted endpoint).
    Dot {
        at: (f64, f64),
        radius: f32,
        alpha: f32,
    },
    /// A ring (the debug view's σ).
    Ring { at: (f64, f64), radius: f32 },
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Scene {
    pub shapes: Vec<Shape>,
}

impl Scene {
    pub fn is_empty(&self) -> bool {
        self.shapes.is_empty()
    }

    /// Where something is drawn, roughly (for choosing which monitors need a layer).
    pub fn bounds(&self) -> Option<ScreenRect> {
        let mut out: Option<ScreenRect> = None;
        let mut add = |r: ScreenRect| {
            out = Some(match out {
                None => r,
                Some(o) => ScreenRect {
                    left: o.left.min(r.left),
                    top: o.top.min(r.top),
                    right: o.right.max(r.right),
                    bottom: o.bottom.max(r.bottom),
                },
            });
        };
        let around = |(x, y): (f64, f64), pad: f64| ScreenRect {
            left: (x - pad) as i32,
            top: (y - pad) as i32,
            right: (x + pad) as i32,
            bottom: (y + pad) as i32,
        };
        for shape in &self.shapes {
            match shape {
                Shape::GhostPath {
                    from, control, to, ..
                } => {
                    add(around(*from, 8.0));
                    add(around(*control, 8.0));
                    add(around(*to, 8.0));
                }
                Shape::Glow { rect, scale, .. } => add(scaled(*rect, *scale, 12)),
                Shape::Caption { at, scale, .. } => add(ScreenRect {
                    left: at.0 as i32,
                    top: at.1 as i32,
                    right: at.0 as i32 + (CAPTION_MAX_W as f32 * scale) as i32,
                    bottom: at.1 as i32 + (CAPTION_H as f32 * scale) as i32,
                }),
                Shape::Dot { at, radius, .. } | Shape::Ring { at, radius } => {
                    add(around(*at, f64::from(*radius) + 2.0))
                }
            }
        }
        out
    }
}

/// A caption's height and widest width at 100 % scaling.
pub const CAPTION_H: i32 = 30;
pub const CAPTION_MAX_W: i32 = 360;

/// `rect` scaled about its centre, padded by `pad`.
pub fn scaled(rect: ScreenRect, scale: f32, pad: i32) -> ScreenRect {
    let cx = f64::from(rect.left + rect.right) / 2.0;
    let cy = f64::from(rect.top + rect.bottom) / 2.0;
    let hw = f64::from(rect.width()) * f64::from(scale) / 2.0 + f64::from(pad);
    let hh = f64::from(rect.height()) * f64::from(scale) / 2.0 + f64::from(pad);
    ScreenRect {
        left: (cx - hw).floor() as i32,
        top: (cy - hh).floor() as i32,
        right: (cx + hw).ceil() as i32,
        bottom: (cy + hh).ceil() as i32,
    }
}

pub fn centre(rect: ScreenRect) -> (f64, f64) {
    (
        f64::from(rect.left + rect.right) / 2.0,
        f64::from(rect.top + rect.bottom) / 2.0,
    )
}

/// A gentle curve from the cursor to a target: the control point sits off the straight line by
/// a fifth of its length, on the side that bows upward (it reads as a gesture, not a ruler).
pub fn ghost_path(from: (f64, f64), to: (f64, f64), alpha: f32) -> Shape {
    let (dx, dy) = (to.0 - from.0, to.1 - from.1);
    let len = dx.hypot(dy).max(1.0);
    let (mx, my) = ((from.0 + to.0) / 2.0, (from.1 + to.1) / 2.0);
    // The normal pointing up the screen (negative y).
    let (mut nx, mut ny) = (-dy / len, dx / len);
    if ny > 0.0 {
        nx = -nx;
        ny = -ny;
    }
    let bow = (len * 0.2).min(120.0);
    Shape::GhostPath {
        from,
        control: (mx + nx * bow, my + ny * bow),
        to,
        alpha,
    }
}

/// How much the right target grows late in a movement (E): from 1.0 at 50 % progress to 1.6 at
/// 90 % and beyond, eased.
pub fn expand_scale(progress: f64) -> f32 {
    let k = ((progress - 0.5) / 0.4).clamp(0.0, 1.0);
    let eased = k * k * (3.0 - 2.0 * k);
    (1.0 + 0.6 * eased) as f32
}

/// Where a caption goes near the cursor: below-right, kept on its monitor, and never over
/// `avoid` (the target the student is heading for: a caption must never be under their click).
/// `text` sets its width; `scale` is the monitor's scaling.
pub fn caption_at(
    cursor: (f64, f64),
    text: &str,
    scale: f32,
    monitor: ScreenRect,
    avoid: Option<ScreenRect>,
) -> (f64, f64) {
    let w = (caption_width(text) as f32 * scale) as i32;
    let h = (CAPTION_H as f32 * scale) as i32;
    let (gap_x, gap_y) = (f64::from(22.0 * scale), f64::from(24.0 * scale));
    let candidates = [
        (cursor.0 + gap_x, cursor.1 + gap_y),
        (cursor.0 + gap_x, cursor.1 - gap_y - f64::from(h)),
        (cursor.0 - gap_x - f64::from(w), cursor.1 + gap_y),
        (
            cursor.0 - gap_x - f64::from(w),
            cursor.1 - gap_y - f64::from(h),
        ),
    ];
    let fits = |(x, y): (f64, f64)| {
        let r = ScreenRect {
            left: x as i32,
            top: y as i32,
            right: x as i32 + w,
            bottom: y as i32 + h,
        };
        let inside = r.left >= monitor.left
            && r.top >= monitor.top
            && r.right <= monitor.right
            && r.bottom <= monitor.bottom;
        let clear = avoid.is_none_or(|a| !intersects(r, scaled(a, 1.6, 6)));
        (inside, clear)
    };
    candidates
        .iter()
        .copied()
        .find(|c| fits(*c) == (true, true))
        .or_else(|| candidates.iter().copied().find(|c| fits(*c).1))
        .map(|(x, y)| clamp_into((x, y), w, h, monitor))
        .unwrap_or_else(|| clamp_into(candidates[0], w, h, monitor))
}

fn clamp_into((x, y): (f64, f64), w: i32, h: i32, m: ScreenRect) -> (f64, f64) {
    (
        x.clamp(
            f64::from(m.left),
            f64::from(m.right - w).max(f64::from(m.left)),
        ),
        y.clamp(
            f64::from(m.top),
            f64::from(m.bottom - h).max(f64::from(m.top)),
        ),
    )
}

pub fn intersects(a: ScreenRect, b: ScreenRect) -> bool {
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/// A caption's width for its text (Segoe UI 14 px, roughly 7.5 px a character, plus padding).
pub fn caption_width(text: &str) -> i32 {
    (text.chars().count() as i32 * 15 / 2 + 24).min(CAPTION_MAX_W)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(l: i32, t: i32, rr: i32, b: i32) -> ScreenRect {
        ScreenRect {
            left: l,
            top: t,
            right: rr,
            bottom: b,
        }
    }

    #[test]
    fn the_target_grows_only_late_in_the_movement() {
        assert_eq!(expand_scale(0.2), 1.0);
        assert_eq!(expand_scale(0.5), 1.0);
        assert!(expand_scale(0.7) > 1.1 && expand_scale(0.7) < 1.5);
        assert!((expand_scale(0.95) - 1.6).abs() < 1e-6);
    }

    #[test]
    fn the_ghost_path_bows_upward_either_way() {
        for (from, to) in [
            ((0.0, 500.0), (800.0, 500.0)),
            ((800.0, 500.0), (0.0, 500.0)),
        ] {
            let Shape::GhostPath { control, .. } = ghost_path(from, to, 0.5) else {
                panic!()
            };
            assert!(control.1 < 500.0, "{control:?}");
        }
    }

    #[test]
    fn a_caption_stays_on_its_monitor_and_off_the_target() {
        // A monitor left of the primary, negative coordinates; cursor near its bottom-right.
        let monitor = r(-1920, 0, 0, 1080);
        let target = r(-80, 1040, -10, 1070);
        let text = "below";
        let at = caption_at((-60.0, 1050.0), text, 1.5, monitor, Some(target));
        let w = (caption_width(text) as f32 * 1.5) as i32;
        let caption = r(at.0 as i32, at.1 as i32, at.0 as i32 + w, at.1 as i32 + 45);
        assert!(caption.left >= monitor.left && caption.right <= monitor.right);
        assert!(caption.top >= monitor.top && caption.bottom <= monitor.bottom);
        assert!(!intersects(caption, target), "{caption:?}");
    }

    #[test]
    fn bounds_cover_every_shape() {
        let scene = Scene {
            shapes: vec![
                Shape::Glow {
                    rect: r(100, 100, 200, 130),
                    scale: 1.6,
                    alpha: 1.0,
                    warn: false,
                },
                Shape::Dot {
                    at: (-500.0, -20.0),
                    radius: 4.0,
                    alpha: 1.0,
                },
            ],
        };
        let b = scene.bounds().unwrap();
        assert!(b.left <= -506 && b.top <= -26 && b.right >= 230 && b.bottom >= 139);
    }
}
