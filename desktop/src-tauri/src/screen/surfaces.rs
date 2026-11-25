//! Shared overlay identities, bundled routes and placement, used by both native backends.

use super::frame::ScreenRect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Ink,
    Pill,
    Clip,
    Notes,
    Coach,
    Pointer,
    Draw,
    Card,
    /// "Quiz me on this" (S6): the question, its choices, a box to type the answer.
    Quiz,
    /// The island: Screen Coach's tools in a bar at the top of the screen (`screen_island.rs`).
    Island,
    /// "neb sees your screen only while this frame is on" (`status.rs`, U8).
    Capsule,
    /// The held Ctrl+Alt keys, with Screen Coach off or paused (`status.rs`, U8).
    Keys,
    /// Neb's hand: Neb's own cursor, which goes and clicks for the student (`screen_hand.rs`).
    Hand,
}

/// Size of the pill, in CSS pixels.
pub const CAPSULE_SIZE: (f64, f64) = (440.0, 52.0);
pub const KEYS_SIZE: (f64, f64) = (500.0, 60.0);

pub const PILL_SIZE: (f64, f64) = (300.0, 52.0);
/// Size of the Circle & Ask card, in CSS pixels (room for a caption and its buttons, targets of
/// at least 44 px: brief §4).
pub const CARD_SIZE: (f64, f64) = (440.0, 236.0);
/// The tallest the card grows to fit what it shows (its destination rows, a long caption, the
/// follow-up box), in CSS pixels; past that the caption scrolls inside it.
pub const CARD_MAX_HEIGHT: f64 = 560.0;

/// The card's window once it fits a page `wanted` CSS pixels tall: as tall as that (between its
/// usual height and `CARD_MAX_HEIGHT`), the same width and top, moved up only as far as it must
/// to stay on the monitor (physical pixels).
pub fn card_fit(window: ScreenRect, monitor: ScreenRect, wanted: f64, scale: f64) -> ScreenRect {
    let css = wanted.clamp(CARD_SIZE.1, CARD_MAX_HEIGHT);
    let height = ((css * scale).round() as i32).min(monitor.height());
    let top = window.top.min(monitor.bottom - height).max(monitor.top);
    ScreenRect {
        left: window.left,
        top,
        right: window.right,
        bottom: top + height,
    }
}

impl Surface {
    /// Every overlay kept out of captures (the preview is an ordinary window, in them already).
    pub const OVERLAYS: [Surface; 12] = [
        Surface::Ink,
        Surface::Pill,
        Surface::Notes,
        Surface::Coach,
        Surface::Pointer,
        Surface::Draw,
        Surface::Card,
        Surface::Quiz,
        Surface::Island,
        Surface::Capsule,
        Surface::Keys,
        Surface::Hand,
    ];

    /// The overlays that can paint an empty white box while hidden (seen with the card once the
    /// student showed Neb in captures; Windows still called it hidden). They take the focus when
    /// clicked, so they aren't made like the rest, and each is placed whenever it's shown.
    #[cfg(windows)]
    pub(crate) const fn parks(self) -> bool {
        matches!(self, Surface::Card | Surface::Quiz | Surface::Notes)
    }

    pub const fn label(self) -> &'static str {
        match self {
            Surface::Ink => "screen-ink",
            Surface::Pill => "screen-ink-pill",
            Surface::Clip => "screen-clip",
            Surface::Notes => "screen-notes",
            Surface::Coach => "screen-coach-pill",
            Surface::Pointer => "screen-pointer",
            Surface::Draw => "screen-draw",
            Surface::Card => "screen-circle-card",
            Surface::Quiz => "screen-quiz-card",
            Surface::Island => "screen-island",
            Surface::Capsule => "screen-capsule",
            Surface::Keys => "screen-keys",
            Surface::Hand => "screen-hand",
        }
    }

    pub(crate) const fn page(self) -> &'static str {
        match self {
            Surface::Ink => "ink-overlay.html",
            Surface::Pill => "ink-pill.html",
            Surface::Clip => "clip-preview.html",
            Surface::Notes => "notes-panel.html",
            Surface::Coach => "coach-pill.html",
            Surface::Pointer => "pointer.html",
            Surface::Draw => "draw-overlay.html",
            Surface::Card => "circle-card.html",
            Surface::Quiz => "quiz-card.html",
            Surface::Island => "island.html",
            Surface::Capsule => "capsule.html",
            Surface::Keys => "keys-hint.html",
            Surface::Hand => "hand.html",
        }
    }
}

pub fn pill_spot(ink: ScreenRect, monitor: ScreenRect, scale: f64) -> ScreenRect {
    let (w, h) = (
        (PILL_SIZE.0 * scale).round() as i32,
        (PILL_SIZE.1 * scale).round() as i32,
    );
    let gap = (8.0 * scale).round() as i32;
    let left = (ink.right - w).clamp(
        monitor.left + gap,
        (monitor.right - w - gap).max(monitor.left),
    );
    let below = ink.bottom + gap;
    let top = if below + h + gap <= monitor.bottom {
        below
    } else {
        // No room below: above the ink, or failing that, inside the monitor's bottom edge.
        (ink.top - gap - h)
            .max(monitor.top + gap)
            .min(monitor.bottom - h - gap)
    };
    ScreenRect {
        left,
        top,
        right: left + w,
        bottom: top + h,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn surfaces_have_unique_window_and_page_identities() {
        let all = Surface::OVERLAYS.into_iter().chain([Surface::Clip]);
        let mut labels = HashSet::new();
        let mut pages = HashSet::new();
        for surface in all {
            assert!(labels.insert(surface.label()));
            assert!(pages.insert(surface.page()));
            assert!(surface.page().ends_with(".html"));
            assert!(!surface.page().contains('/'));
        }
        assert_eq!(labels.len(), 13);
        assert!(!Surface::OVERLAYS.contains(&Surface::Clip));
    }

    #[test]
    fn card_stays_inside_a_retina_monitor_left_of_primary() {
        let monitor = ScreenRect {
            left: -2880,
            top: -100,
            right: 0,
            bottom: 1700,
        };
        let card = ScreenRect {
            left: -1000,
            top: 1400,
            right: -120,
            bottom: 1872,
        };
        let fitted = card_fit(card, monitor, 500.0, 2.0);
        assert_eq!(fitted.width(), 880);
        assert_eq!(fitted.height(), 1000);
        assert_eq!(fitted.bottom, monitor.bottom);
    }
}
