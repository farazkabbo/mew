//! What the student's marks mean (Circle & Ask, docs/SCREEN_COACH_S3_2.md §3.3). Pure geometry:
//! no model, no I/O, fully tested.
//!
//! A finished stroke is one of:
//! - a **circle** (the path closes, or encloses an area): "this region";
//! - an **underline** (flat and wide): "this line", the text just above it;
//! - an **arrow** (a line with a short V at its far end): "this thing", what's at the tip;
//! - a **tap** (hardly any path): "this word" (two taps in the same place: its paragraph);
//! - anything else, a **loose** region: its bounding box.
//!
//! Everything is in physical screen pixels (`Pt`), like the capture's OCR words. What the
//! model gets is normalised to 0–1000 across the capture (`to_normalised`).

use serde::Serialize;

use super::frame::ScreenRect;

/// A point of a stroke, in screen pixels.
pub type Pt = (f32, f32);

/// At most this many marks per question (brief §2.2).
pub const MAX_MARKS: usize = 3;
/// A polygon sent to the model has at most this many points.
const POLYGON_POINTS: usize = 48;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MarkKind {
    Circle,
    Underline,
    Arrow,
    Tap,
    Loose,
}

/// Sizes that depend on the monitor's scaling (`scale` = physical pixels per CSS pixel).
#[derive(Debug, Clone, Copy)]
struct Sizes {
    /// A tap moves less than this.
    tap: f32,
    /// An underline is at least this wide.
    underline_width: f32,
}

impl Sizes {
    fn at(scale: f32) -> Self {
        let scale = scale.max(1.0);
        Self {
            tap: 10.0 * scale,
            underline_width: 24.0 * scale,
        }
    }
}

/// What a finished stroke is.
pub fn classify(points: &[Pt], scale: f32) -> MarkKind {
    let sizes = Sizes::at(scale);
    let Some(bbox) = bounds(points) else {
        return MarkKind::Tap;
    };
    let length = path_length(points);
    let (w, h) = (bbox.2 - bbox.0, bbox.3 - bbox.1);
    if length < sizes.tap || w.max(h) < sizes.tap {
        return MarkKind::Tap;
    }
    let (start, end) = (points[0], points[points.len() - 1]);
    let closes = distance(start, end) <= 0.15 * length;
    let encloses =
        w > 2.0 * sizes.tap && h > 2.0 * sizes.tap && polygon_area(points) >= 0.35 * w * h;
    if (closes && w > sizes.tap && h > sizes.tap) || encloses {
        return MarkKind::Circle;
    }
    if is_arrow(points, length) {
        return MarkKind::Arrow;
    }
    if w >= sizes.underline_width && h <= 0.25 * w {
        return MarkKind::Underline;
    }
    MarkKind::Loose
}

/// An arrow: the path goes out to a tip, then comes back a little (the V).
fn is_arrow(points: &[Pt], length: f32) -> bool {
    let start = points[0];
    let Some((tip_index, _)) = points
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| distance(start, **a).total_cmp(&distance(start, **b)))
    else {
        return false;
    };
    let tip = points[tip_index];
    let shaft = distance(start, tip);
    let head = path_length(&points[tip_index..]);
    // The head is a short stroke back from the tip: more than a scribble, far less than the shaft.
    tip_index > 1 && shaft > 0.6 * (length - head) && head >= 0.12 * shaft && head <= 0.9 * shaft
}

/// The point an arrow points at (its tip: the point farthest from where it started).
pub fn arrow_tip(points: &[Pt]) -> Option<Pt> {
    let start = *points.first()?;
    points
        .iter()
        .copied()
        .max_by(|a, b| distance(start, *a).total_cmp(&distance(start, *b)))
}

// ─── What the mark is about ──────────────────────────────────────────────────────────────────

/// A word on the screen (from the capture's OCR), as marks see it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WordBox {
    pub rect: ScreenRect,
    /// Which OCR line it's on.
    pub line: u32,
}

/// Which words a mark is about: their indexes in `words`. Whole words only ("snapping"): a
/// circle that cuts through a word takes it if at least half of it is inside.
pub fn target_words(kind: MarkKind, points: &[Pt], words: &[WordBox], scale: f32) -> Vec<usize> {
    let indexes = |keep: &dyn Fn(&WordBox) -> bool| {
        words
            .iter()
            .enumerate()
            .filter(|(_, w)| keep(w))
            .map(|(i, _)| i)
            .collect::<Vec<_>>()
    };
    match kind {
        MarkKind::Circle => indexes(&|w| inside_share(&w.rect, points) >= 0.5),
        MarkKind::Loose => match bounds(points) {
            Some(b) => indexes(&|w| centre_in_box(&w.rect, b)),
            None => Vec::new(),
        },
        MarkKind::Underline => underlined(points, words),
        MarkKind::Arrow => arrow_tip(points)
            .map(|tip| line_at(tip, words, scale))
            .unwrap_or_default(),
        MarkKind::Tap => points
            .first()
            .and_then(|p| nearest_word(*p, words, scale))
            .into_iter()
            .collect(),
    }
}

/// The words of the OCR line(s) just above an underline, over its width.
fn underlined(points: &[Pt], words: &[WordBox]) -> Vec<usize> {
    let Some((left, top, right, bottom)) = bounds(points) else {
        return Vec::new();
    };
    let y = (top + bottom) / 2.0;
    let overlaps = |w: &WordBox| (w.rect.left as f32) < right && (w.rect.right as f32) > left;
    // The closest line whose words sit above the underline (within about two lines).
    let line = words
        .iter()
        .filter(|w| overlaps(w))
        .filter(|w| {
            let gap = y - w.rect.bottom as f32;
            let height = w.rect.height().max(1) as f32;
            (-0.5 * height..=1.5 * height).contains(&gap)
        })
        .min_by(|a, b| {
            (y - a.rect.bottom as f32)
                .abs()
                .total_cmp(&(y - b.rect.bottom as f32).abs())
        })
        .map(|w| w.line);
    match line {
        Some(line) => words
            .iter()
            .enumerate()
            .filter(|(_, w)| w.line == line && overlaps(w))
            .map(|(i, _)| i)
            .collect(),
        None => Vec::new(),
    }
}

/// The whole OCR line under (or nearest to) `point`.
fn line_at(point: Pt, words: &[WordBox], scale: f32) -> Vec<usize> {
    match nearest_word(point, words, scale) {
        Some(nearest) => {
            let line = words[nearest].line;
            words
                .iter()
                .enumerate()
                .filter(|(_, w)| w.line == line)
                .map(|(i, _)| i)
                .collect()
        }
        None => Vec::new(),
    }
}

/// The word under `point`, or the nearest one within a word's height (scaled) of it.
pub fn nearest_word(point: Pt, words: &[WordBox], scale: f32) -> Option<usize> {
    let reach = 16.0 * scale.max(1.0);
    words
        .iter()
        .enumerate()
        .map(|(i, w)| (i, distance_to_rect(point, &w.rect)))
        .filter(|(_, d)| *d <= reach)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(i, _)| i)
}

/// The region a mark covers on screen (for the crop and for keeping the tutor's ink near it):
/// its path's bounds, grown to the words it's about.
pub fn region(points: &[Pt], words: &[WordBox], targets: &[usize]) -> Option<ScreenRect> {
    let (left, top, right, bottom) = bounds(points)?;
    let mut rect = ScreenRect {
        left: left.floor() as i32,
        top: top.floor() as i32,
        right: right.ceil() as i32,
        bottom: bottom.ceil() as i32,
    };
    for &i in targets {
        if let Some(word) = words.get(i) {
            rect = super::screen_text::union([rect, word.rect]).unwrap_or(rect);
        }
    }
    Some(rect)
}

// ─── For the model ───────────────────────────────────────────────────────────────────────────

/// A 0–1000 point across the capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct NormPoint {
    pub x: u16,
    pub y: u16,
}

/// Screen pixels → 0–1000 across `bounds`, clamped.
pub fn to_normalised((x, y): Pt, bounds: ScreenRect) -> NormPoint {
    let norm = |v: f32, start: i32, size: i32| {
        (((v - start as f32) / size.max(1) as f32) * 1000.0)
            .round()
            .clamp(0.0, 1000.0) as u16
    };
    NormPoint {
        x: norm(x, bounds.left, bounds.width()),
        y: norm(y, bounds.top, bounds.height()),
    }
}

/// The path, thinned to at most `POLYGON_POINTS` points evenly along it (enough for the model
/// to see the shape; the full stroke stays here for the notebook).
pub fn simplified(points: &[Pt]) -> Vec<Pt> {
    if points.len() <= POLYGON_POINTS {
        return points.to_vec();
    }
    let step = (points.len() - 1) as f32 / (POLYGON_POINTS - 1) as f32;
    (0..POLYGON_POINTS)
        .map(|i| points[((i as f32 * step).round() as usize).min(points.len() - 1)])
        .collect()
}

// ─── Geometry ────────────────────────────────────────────────────────────────────────────────

fn distance(a: Pt, b: Pt) -> f32 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

fn path_length(points: &[Pt]) -> f32 {
    points.windows(2).map(|w| distance(w[0], w[1])).sum()
}

/// (left, top, right, bottom) of the points.
fn bounds(points: &[Pt]) -> Option<(f32, f32, f32, f32)> {
    let first = points.first()?;
    Some(points.iter().fold(
        (first.0, first.1, first.0, first.1),
        |(l, t, r, b), &(x, y)| (l.min(x), t.min(y), r.max(x), b.max(y)),
    ))
}

/// The area the path encloses when closed (shoelace formula).
fn polygon_area(points: &[Pt]) -> f32 {
    let n = points.len();
    if n < 3 {
        return 0.0;
    }
    let twice: f32 = (0..n)
        .map(|i| {
            let (a, b) = (points[i], points[(i + 1) % n]);
            a.0 * b.1 - b.0 * a.1
        })
        .sum();
    twice.abs() / 2.0
}

/// Inside the closed path (even-odd rule).
fn inside(point: Pt, polygon: &[Pt]) -> bool {
    let mut inside = false;
    let n = polygon.len();
    for i in 0..n {
        let (a, b) = (polygon[i], polygon[(i + n - 1) % n]);
        if (a.1 > point.1) != (b.1 > point.1)
            && point.0 < (b.0 - a.0) * (point.1 - a.1) / (b.1 - a.1) + a.0
        {
            inside = !inside;
        }
    }
    inside
}

/// How much of `rect` is inside the closed path, sampled on a 3×3 grid.
fn inside_share(rect: &ScreenRect, polygon: &[Pt]) -> f32 {
    let mut hits = 0;
    for i in 0..3 {
        for j in 0..3 {
            let x = rect.left as f32 + rect.width() as f32 * (i as f32 + 0.5) / 3.0;
            let y = rect.top as f32 + rect.height() as f32 * (j as f32 + 0.5) / 3.0;
            if inside((x, y), polygon) {
                hits += 1;
            }
        }
    }
    hits as f32 / 9.0
}

fn centre_in_box(rect: &ScreenRect, (left, top, right, bottom): (f32, f32, f32, f32)) -> bool {
    let cx = (rect.left + rect.right) as f32 / 2.0;
    let cy = (rect.top + rect.bottom) as f32 / 2.0;
    cx >= left && cx <= right && cy >= top && cy <= bottom
}

fn distance_to_rect((x, y): Pt, rect: &ScreenRect) -> f32 {
    let dx = (rect.left as f32 - x).max(0.0).max(x - rect.right as f32);
    let dy = (rect.top as f32 - y).max(0.0).max(y - rect.bottom as f32);
    (dx * dx + dy * dy).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A loop drawn around (cx, cy), like a hand would: not quite closing.
    fn circle(cx: f32, cy: f32, rx: f32, ry: f32, turn: f32) -> Vec<Pt> {
        (0..=60)
            .map(|i| {
                let a = turn * std::f32::consts::TAU * i as f32 / 60.0;
                (cx + rx * a.cos(), cy + ry * a.sin())
            })
            .collect()
    }

    fn line(from: Pt, to: Pt, n: usize) -> Vec<Pt> {
        (0..=n)
            .map(|i| {
                let t = i as f32 / n as f32;
                (from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t)
            })
            .collect()
    }

    /// Words 60×20 px, 10 px apart, rows 40 px apart, starting at (100, 100).
    fn page(rows: usize, cols: usize) -> Vec<WordBox> {
        let mut words = Vec::new();
        for row in 0..rows {
            for col in 0..cols {
                let (left, top) = (100 + col as i32 * 70, 100 + row as i32 * 40);
                words.push(WordBox {
                    rect: ScreenRect {
                        left,
                        top,
                        right: left + 60,
                        bottom: top + 20,
                    },
                    line: row as u32,
                });
            }
        }
        words
    }

    #[test]
    fn recognises_each_kind_of_mark() {
        assert_eq!(
            classify(&circle(300.0, 200.0, 120.0, 60.0, 0.97), 1.0),
            MarkKind::Circle
        );
        // An open loop that still encloses most of its box.
        assert_eq!(
            classify(&circle(300.0, 200.0, 120.0, 60.0, 0.85), 1.0),
            MarkKind::Circle
        );
        assert_eq!(
            classify(&line((100.0, 300.0), (400.0, 306.0), 40), 1.0),
            MarkKind::Underline
        );
        assert_eq!(classify(&[(10.0, 10.0), (12.0, 11.0)], 1.0), MarkKind::Tap);
        assert_eq!(classify(&[(10.0, 10.0)], 1.0), MarkKind::Tap);

        let mut arrow = line((100.0, 400.0), (300.0, 300.0), 30);
        arrow.extend(line((300.0, 300.0), (270.0, 330.0), 6));
        assert_eq!(classify(&arrow, 1.0), MarkKind::Arrow);
        assert_eq!(arrow_tip(&arrow), Some((300.0, 300.0)));

        // A zigzag scribble is just a region.
        let zigzag: Vec<Pt> = (0..20)
            .map(|i| {
                (
                    100.0 + i as f32 * 10.0,
                    if i % 2 == 0 { 100.0 } else { 160.0 },
                )
            })
            .collect();
        assert_eq!(classify(&zigzag, 1.0), MarkKind::Loose);
    }

    #[test]
    fn scales_with_the_monitor() {
        // 15 px of movement is a tap at 200 % (7.5 CSS pixels), not at 100 %.
        let short = line((10.0, 10.0), (25.0, 10.0), 5);
        assert_eq!(classify(&short, 2.0), MarkKind::Tap);
        assert_ne!(classify(&short, 1.0), MarkKind::Tap);
    }

    #[test]
    fn a_circle_takes_whole_words_at_least_half_inside() {
        let words = page(3, 4);
        // Around the second row's first two words, cutting the third one near its edge.
        let loop_ = circle(170.0, 150.0, 85.0, 22.0, 1.0);
        let targets = target_words(MarkKind::Circle, &loop_, &words, 1.0);
        assert_eq!(targets, vec![4, 5]);
        let region = region(&loop_, &words, &targets).unwrap();
        assert!(region.left <= 100 && region.right >= 230);
    }

    #[test]
    fn an_underline_takes_the_line_above_it() {
        let words = page(3, 4);
        // Under the first three words of row 2 (y 140–160), a few pixels below.
        let underline = line((95.0, 165.0), (300.0, 167.0), 20);
        assert_eq!(
            target_words(MarkKind::Underline, &underline, &words, 1.0),
            vec![4, 5, 6]
        );
        // Far below any text: nothing.
        let alone = line((95.0, 600.0), (300.0, 600.0), 20);
        assert!(target_words(MarkKind::Underline, &alone, &words, 1.0).is_empty());
    }

    #[test]
    fn an_arrow_and_a_tap_point_at_a_line_and_a_word() {
        let words = page(3, 4);
        let mut arrow = line((500.0, 300.0), (245.0, 190.0), 30);
        arrow.extend(line((245.0, 190.0), (265.0, 200.0), 5));
        // The tip is on row 3's third word: the whole row.
        assert_eq!(
            target_words(MarkKind::Arrow, &arrow, &words, 1.0),
            vec![8, 9, 10, 11]
        );
        assert_eq!(
            target_words(MarkKind::Tap, &[(310.0, 112.0)], &words, 1.0),
            vec![3]
        );
        assert!(target_words(MarkKind::Tap, &[(900.0, 900.0)], &words, 1.0).is_empty());
    }

    #[test]
    fn normalises_onto_the_capture_and_thins_long_paths() {
        let bounds = ScreenRect {
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1080,
        };
        assert_eq!(
            to_normalised((-960.0, 540.0), bounds),
            NormPoint { x: 500, y: 500 }
        );
        assert_eq!(
            to_normalised((-3000.0, 2000.0), bounds),
            NormPoint { x: 0, y: 1000 }
        );
        let long = circle(0.0, 0.0, 50.0, 50.0, 1.0);
        let thin = simplified(&long);
        assert_eq!(thin.len(), 48);
        assert_eq!(thin.first(), long.first());
        assert_eq!(thin.last(), long.last());
    }
}
