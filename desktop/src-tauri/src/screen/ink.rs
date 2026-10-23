//! Ink geometry (S3): what the overlay is asked to draw, checking what it reports back, the
//! default crop of a clip, and moving ink when the page moved. Pure: no I/O, fully tested.
//!
//! Coordinate spaces:
//! - normalised: 0–1000 across the screenshot (what the model returns);
//! - screen: physical pixels of the virtual screen (`ScreenRect`; may be negative);
//! - overlay: physical pixels from the top-left of the monitor the overlay covers;
//! - frame: physical pixels from the top-left of the captured area (crops and clip strokes).

use serde::{Deserialize, Serialize};

use super::frame::{FrameMeta, ScreenRect};
use super::protocol::{Box2, ClipStroke, ScreenAction};
use super::screen_text::ScreenText;

/// A rectangle as [x, y, width, height] (the ink library's `BBox`).
pub type Rect = [f32; 4];

/// The tutor's ink colours (light theme; the overlay never remaps them).
pub const TUTOR_INK: &str = "#8a7bf0";
pub const TUTOR_HIGHLIGHT: &str = "#8a7bf055";

/// Caps on what the overlay may report (the planner's own cap is 30,000 points).
const MAX_STROKES: usize = 400;
const MAX_POINTS_PER_STROKE: usize = 4_000;
const MAX_POINTS: usize = 30_000;
const MAX_CARDS: usize = 8;
/// Padding around a clip's default crop, in CSS pixels (brief §3.2: 24 px).
const CROP_PADDING_CSS: f32 = 24.0;

// ─── Asking the overlay to draw ──────────────────────────────────────────────────────────────

/// What the overlay page gets: everything it needs to plan, nothing of the screen but
/// rectangles (decision 2).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InkRequest {
    /// Identifies this drawing; the overlay sends it back with what it drew.
    pub id: u64,
    pub seed: String,
    pub actions: Vec<ScreenAction>,
    /// The captured area, in overlay pixels.
    pub frame: Rect,
    /// The monitor, in overlay pixels (always at 0, 0).
    pub bounds: Rect,
    pub obstacles: Vec<Rect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_height: Option<f32>,
    /// Physical pixels per CSS pixel.
    pub scale: f32,
    pub colors: InkColors,
    /// Windows' "Animation effects": off → draw at once (brief §4.3).
    pub animate: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct InkColors {
    pub ink: String,
    pub highlight: String,
}

/// Builds the overlay's request for a reply's actions on the frame described by `meta`.
pub fn ink_request(
    id: u64,
    seed: &str,
    actions: &[ScreenAction],
    meta: &FrameMeta,
    text: &ScreenText,
    animate: bool,
    contrast_colour: Option<&str>,
) -> InkRequest {
    let monitor = meta.monitor;
    let to_overlay = |r: ScreenRect| -> Rect {
        [
            (r.left - monitor.left) as f32,
            (r.top - monitor.top) as f32,
            r.width() as f32,
            r.height() as f32,
        ]
    };
    let frame = to_overlay(meta.bounds);
    let ink = contrast_colour.unwrap_or(TUTOR_INK).to_owned();
    let highlight = match contrast_colour {
        Some(colour) => format!("{colour}55"),
        None => TUTOR_HIGHLIGHT.to_owned(),
    };
    InkRequest {
        id,
        seed: seed.to_owned(),
        actions: actions.to_vec(),
        frame,
        bounds: [0.0, 0.0, monitor.width() as f32, monitor.height() as f32],
        obstacles: text.rects().map(to_overlay).collect(),
        text_height: text.typical_height(),
        scale: meta.dpi.max(96) as f32 / 96.0,
        colors: InkColors { ink, highlight },
        animate,
    }
}

// ─── What the overlay drew ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InkTool {
    Pen,
    Highlighter,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkStroke {
    pub tool: InkTool,
    pub color: String,
    pub width: f32,
    /// [x, y, pressure, t] in overlay pixels.
    pub points: Vec<[f32; 4]>,
}

/// The ink the overlay drew for request `id`, in overlay pixels.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DrawnInk {
    pub id: u64,
    pub strokes: Vec<InkStroke>,
    /// Sticky notes' paper.
    pub cards: Vec<Rect>,
    /// The focus region and everything drawn (the default crop before padding).
    pub bbox: Option<Rect>,
}

/// Checks what the overlay reported before keeping it: sizes capped, numbers finite and on the
/// monitor (with a margin for strokes that run off an edge), colours plain hex. The overlay is
/// our own bundled page, but nothing a WebView says is trusted blindly.
pub fn check_drawn(ink: DrawnInk, monitor: ScreenRect) -> Option<DrawnInk> {
    let (w, h) = (monitor.width() as f32, monitor.height() as f32);
    let on_monitor = |x: f32, y: f32| {
        x.is_finite() && y.is_finite() && (-w..=2.0 * w).contains(&x) && (-h..=2.0 * h).contains(&y)
    };
    let rect_ok = |r: &Rect| {
        on_monitor(r[0], r[1]) && r[2].is_finite() && r[3].is_finite() && r[2] >= 0.0 && r[3] >= 0.0
    };
    let total: usize = ink.strokes.iter().map(|s| s.points.len()).sum();
    let strokes_ok = ink.strokes.len() <= MAX_STROKES
        && total <= MAX_POINTS
        && ink.strokes.iter().all(|s| {
            !s.points.is_empty()
                && s.points.len() <= MAX_POINTS_PER_STROKE
                && s.width.is_finite()
                && s.width > 0.0
                && s.width <= 200.0
                && is_hex_colour(&s.color)
                && s.points.iter().all(|[x, y, p, t]| {
                    on_monitor(*x, *y) && (0.0..=1.0).contains(p) && t.is_finite() && *t >= 0.0
                })
        });
    let ok = strokes_ok
        && ink.cards.len() <= MAX_CARDS
        && ink.cards.iter().all(rect_ok)
        && ink.bbox.as_ref().is_none_or(rect_ok);
    ok.then_some(ink)
}

fn is_hex_colour(text: &str) -> bool {
    text.strip_prefix('#').is_some_and(|hex| {
        (hex.len() == 6 || hex.len() == 8) && hex.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

// ─── Clips ───────────────────────────────────────────────────────────────────────────────────

/// Overlay pixels → frame pixels (the overlay covers the monitor; the frame is the capture).
pub fn overlay_to_frame(meta: &FrameMeta) -> (f32, f32) {
    (
        (meta.monitor.left - meta.bounds.left) as f32,
        (meta.monitor.top - meta.bounds.top) as f32,
    )
}

/// The default crop of a clip, in frame pixels: the focus region and all ink (`bbox`, in
/// overlay pixels) plus 24 CSS pixels, clamped to the capture. None if nothing is left.
pub fn default_crop(bbox: Rect, meta: &FrameMeta) -> Option<Rect> {
    let (dx, dy) = overlay_to_frame(meta);
    let pad = CROP_PADDING_CSS * meta.dpi.max(96) as f32 / 96.0;
    let rect = [bbox[0] + dx - pad, bbox[1] + dy - pad, bbox[2] + 2.0 * pad, bbox[3] + 2.0 * pad];
    clamp_rect(
        rect,
        [0.0, 0.0, meta.bounds.width() as f32, meta.bounds.height() as f32],
    )
}

/// `rect` cut down to fit inside `area`; None if they don't overlap (or it's too thin to keep).
pub fn clamp_rect(rect: Rect, area: Rect) -> Option<Rect> {
    let left = rect[0].max(area[0]);
    let top = rect[1].max(area[1]);
    let right = (rect[0] + rect[2]).min(area[0] + area[2]);
    let bottom = (rect[1] + rect[3]).min(area[1] + area[3]);
    (right - left >= 8.0 && bottom - top >= 8.0).then_some([left, top, right - left, bottom - top])
}

/// The tutor's strokes for a clip: moved from overlay pixels into the crop (`crop` in frame
/// pixels) and scaled by `scale` (clip image pixels per frame pixel). Strokes entirely outside
/// the crop are left out.
pub fn clip_strokes(
    strokes: &[InkStroke],
    meta: &FrameMeta,
    crop: Rect,
    scale: f32,
) -> Vec<ClipStroke> {
    let (dx, dy) = overlay_to_frame(meta);
    strokes
        .iter()
        .filter(|stroke| {
            stroke.points.iter().any(|[x, y, ..]| {
                let (fx, fy) = (x + dx, y + dy);
                fx >= crop[0] && fx <= crop[0] + crop[2] && fy >= crop[1] && fy <= crop[1] + crop[3]
            })
        })
        .map(|stroke| ClipStroke {
            tool: match stroke.tool {
                InkTool::Pen => "pen",
                InkTool::Highlighter => "highlighter",
            },
            color: stroke.color.clone(),
            width: (stroke.width * scale).clamp(0.1, 100.0),
            points: stroke
                .points
                .iter()
                .map(|[x, y, p, t]| [(x + dx - crop[0]) * scale, (y + dy - crop[1]) * scale, *p, *t])
                .collect(),
        })
        .collect()
}

// ─── Re-placing ink after the page moved ────────────────────────────────────────────────────

/// Moves `actions` (normalised over `old`) to where the same content is now: the anchor text was
/// at `was` and is now at `now` (screen pixels), and the new capture covers `new`. A zoom is
/// followed too (the anchor's width). None if the focus region would end up mostly off screen.
pub fn move_actions(
    actions: &[ScreenAction],
    old: ScreenRect,
    new: ScreenRect,
    was: ScreenRect,
    now: ScreenRect,
) -> Option<Vec<ScreenAction>> {
    if [old, new, was].iter().any(|r| r.width() <= 0 || r.height() <= 0) {
        return None;
    }
    let zoom = (now.width() as f64 / was.width() as f64).clamp(0.5, 2.0);
    let map = |x: u16, y: u16| -> (u16, u16) {
        let sx = old.left as f64 + f64::from(x) / 1000.0 * old.width() as f64;
        let sy = old.top as f64 + f64::from(y) / 1000.0 * old.height() as f64;
        let nx = now.left as f64 + (sx - was.left as f64) * zoom;
        let ny = now.top as f64 + (sy - was.top as f64) * zoom;
        let to_norm = |v: f64, start: i32, size: i32| {
            ((v - start as f64) / size as f64 * 1000.0).round().clamp(0.0, 1000.0) as u16
        };
        (to_norm(nx, new.left, new.width()), to_norm(ny, new.top, new.height()))
    };
    let moved: Vec<ScreenAction> = actions.iter().map(|a| a.map_coordinates(map)).collect();

    // Clamping squashes whatever left the screen: check how much of the focus region survived.
    let focus = |list: &[ScreenAction]| {
        list.iter().find_map(|a| match a {
            ScreenAction::FocusRegion { region, .. } => Some(*region),
            _ => None,
        })
    };
    if let (Some(before), Some(after)) = (focus(actions), focus(&moved)) {
        let area = |b: Box2| f64::from(b.right - b.left) * f64::from(b.bottom - b.top);
        let expected = area(before) * zoom * zoom * old.width() as f64 * old.height() as f64
            / (new.width() as f64 * new.height() as f64);
        if expected > 0.0 && area(after) < expected * 0.5 {
            return None;
        }
    }
    Some(moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::frame::{TargetKind, Timings};
    use crate::screen::protocol::{FocusKind, Point};

    /// A window on a 150 % monitor left of the primary one.
    fn meta() -> FrameMeta {
        FrameMeta {
            kind: TargetKind::Window,
            app: Some("msedge.exe".into()),
            bounds: ScreenRect {
                left: -2400,
                top: 100,
                right: -400,
                bottom: 1300,
            },
            monitor: ScreenRect {
                left: -2880,
                top: 0,
                right: 0,
                bottom: 1620,
            },
            dpi: 144,
            width: 1600,
            height: 960,
            timings: Timings::default(),
            video_playing: None,
            window: None,
        }
    }

    fn stroke(points: &[[f32; 2]]) -> InkStroke {
        InkStroke {
            tool: InkTool::Pen,
            color: TUTOR_INK.into(),
            width: 3.0,
            points: points.iter().map(|[x, y]| [*x, *y, 0.5, 0.0]).collect(),
        }
    }

    #[test]
    fn tells_the_overlay_where_the_capture_is_on_its_monitor() {
        let request = ink_request(7, "turn", &[], &meta(), &ScreenText::default(), true, None);
        assert_eq!(request.frame, [480.0, 100.0, 2000.0, 1200.0]);
        assert_eq!(request.bounds, [0.0, 0.0, 2880.0, 1620.0]);
        assert_eq!(request.scale, 1.5);
        assert_eq!(request.colors.ink, TUTOR_INK);
        let contrast =
            ink_request(7, "turn", &[], &meta(), &ScreenText::default(), false, Some("#00ff00"));
        assert_eq!(contrast.colors.highlight, "#00ff0055");
    }

    #[test]
    fn accepts_sane_ink_and_refuses_the_rest() {
        let monitor = meta().monitor;
        let good = DrawnInk {
            id: 1,
            strokes: vec![stroke(&[[10.0, 10.0], [20.0, 12.0]])],
            cards: vec![[0.0, 0.0, 100.0, 50.0]],
            bbox: Some([5.0, 5.0, 40.0, 20.0]),
        };
        assert!(check_drawn(good.clone(), monitor).is_some());

        let mut bad = good.clone();
        bad.strokes[0].points[0][0] = f32::NAN;
        assert!(check_drawn(bad, monitor).is_none(), "not a number");
        let mut bad = good.clone();
        bad.strokes[0].color = "red; background: url(x)".into();
        assert!(check_drawn(bad, monitor).is_none(), "not a hex colour");
        let mut bad = good.clone();
        bad.strokes[0].points[0][1] = 1e9;
        assert!(check_drawn(bad, monitor).is_none(), "far off the monitor");
        let mut bad = good.clone();
        bad.strokes = vec![stroke(&[[1.0, 1.0]]); MAX_STROKES + 1];
        assert!(check_drawn(bad, monitor).is_none(), "too many strokes");
        let mut bad = good;
        bad.strokes[0].points.clear();
        assert!(check_drawn(bad, monitor).is_none(), "empty stroke");
        assert!(serde_json::from_str::<DrawnInk>(
            r#"{"id":1,"strokes":[],"cards":[],"bbox":null,"script":"x"}"#
        )
        .is_err());
    }

    #[test]
    fn pads_and_clamps_the_default_crop() {
        // Ink near the window's top-left corner, in overlay pixels (the frame starts at 480, 100).
        let crop = default_crop([500.0, 120.0, 300.0, 100.0], &meta()).unwrap();
        // 24 CSS px at 150 % = 36 px of padding, clamped at the frame's edge.
        assert_eq!(crop, [0.0, 0.0, 356.0, 156.0]);
        let middle = default_crop([1480.0, 600.0, 200.0, 100.0], &meta()).unwrap();
        assert_eq!(middle, [964.0, 464.0, 272.0, 172.0]);
        assert_eq!(default_crop([0.0, 0.0, 100.0, 50.0], &meta()), None, "off the frame");
    }

    #[test]
    fn moves_strokes_into_the_crop_and_scales_them() {
        let strokes = [
            stroke(&[[1480.0, 600.0], [1500.0, 610.0]]),
            stroke(&[[100.0, 100.0], [110.0, 100.0]]), // outside the crop
        ];
        let crop = [964.0, 464.0, 272.0, 172.0];
        let clipped = clip_strokes(&strokes, &meta(), crop, 0.5);
        assert_eq!(clipped.len(), 1);
        // Overlay 1480 → frame 1000 → crop 36 → half size 18.
        assert_eq!(clipped[0].points[0], [18.0, 18.0, 0.5, 0.0]);
        assert_eq!(clipped[0].width, 1.5);
        assert_eq!(clipped[0].tool, "pen");
    }

    #[test]
    fn follows_the_content_when_the_page_scrolls_or_zooms() {
        let window = ScreenRect {
            left: 0,
            top: 0,
            right: 1000,
            bottom: 1000,
        };
        let focus = ScreenAction::FocusRegion {
            region: Box2 {
                left: 100,
                top: 400,
                right: 500,
                bottom: 500,
            },
            kind: FocusKind::Question,
        };
        let arrow = ScreenAction::PointAt {
            point: Point { x: 200, y: 450 },
            label: None,
        };
        let was = ScreenRect {
            left: 100,
            top: 400,
            right: 300,
            bottom: 420,
        };
        // Scrolled up 200 px.
        let now = ScreenRect {
            left: 100,
            top: 200,
            right: 300,
            bottom: 220,
        };
        let moved = move_actions(&[focus.clone(), arrow.clone()], window, window, was, now).unwrap();
        assert_eq!(
            moved[1],
            ScreenAction::PointAt {
                point: Point { x: 200, y: 250 },
                label: None
            }
        );
        // Zoomed in to 150 % around the same spot.
        let zoomed = ScreenRect {
            left: 100,
            top: 400,
            right: 400,
            bottom: 430,
        };
        let moved = move_actions(&[focus.clone(), arrow], window, window, was, zoomed).unwrap();
        assert_eq!(
            moved[1],
            ScreenAction::PointAt {
                point: Point { x: 250, y: 475 },
                label: None
            }
        );
        // Scrolled so far the question is nearly gone.
        let gone = ScreenRect {
            left: 100,
            top: -380,
            right: 300,
            bottom: -360,
        };
        assert_eq!(move_actions(&[focus], window, window, was, gone), None);
    }
}
