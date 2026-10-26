//! Neb's one global gesture (K2, docs/NOTEBOOKS_K.md §11.1): **hold left Ctrl + left Alt** to
//! circle and talk at the same time, and **double-tap** them to toggle draw mode. Pure: fed with
//! what the keys look like at each poll (`keys.rs` reads them), it says what happened.
//!
//! The AltGr guard: AltGr is right Alt plus Ctrl, which never counts (the reader leaves it out),
//! and on many layouts left Ctrl + left Alt types characters too ("€" is Ctrl+Alt+E). So the hold
//! only starts after 300 ms with no other key down, and any other key cancels it silently, before
//! or after it started: a key means the student is typing or using another shortcut.

use std::time::{Duration, Instant};

/// How long the two keys must be held, alone, before the hold starts.
pub const GUARD: Duration = Duration::from_millis(300);
/// The longest gap between two taps that still makes a double tap.
pub const DOUBLE_TAP_GAP: Duration = Duration::from_millis(400);

/// The keys at one poll.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Keys {
    /// Left Ctrl and left Alt are both down (and right Alt isn't).
    pub held: bool,
    /// Any other key is down, or was pressed since the last poll (mouse buttons don't count:
    /// they draw).
    pub other: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldEvent {
    /// The guard passed: draw mode on, and listening (if voice is on).
    Started,
    /// The keys came up after the hold started: ask.
    Ended,
    /// Another key was pressed during the hold: stop, ask nothing.
    Cancelled,
    /// Two quick taps: draw mode on or off.
    DoubleTap,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Up,
    /// Both keys down since then, nothing else yet.
    Guarding(Instant),
    Holding,
    /// Another key was involved: nothing happens until both keys are up again.
    Spoiled,
}

#[derive(Debug, Default)]
pub struct HoldGesture {
    phase: Phase,
    /// When the last tap (a press shorter than the guard) ended.
    last_tap: Option<Instant>,
}

impl HoldGesture {
    /// The keys as they are `now`; what that means, if anything.
    pub fn step(&mut self, keys: Keys, now: Instant) -> Option<HoldEvent> {
        match self.phase {
            Phase::Up if keys.held && keys.other => {
                self.phase = Phase::Spoiled;
                None
            }
            Phase::Up if keys.held => {
                self.phase = Phase::Guarding(now);
                None
            }
            Phase::Up => None,
            Phase::Guarding(since) if !keys.held => {
                self.phase = Phase::Up;
                let double = self
                    .last_tap
                    .is_some_and(|tap| since.duration_since(tap) <= DOUBLE_TAP_GAP);
                if double {
                    self.last_tap = None;
                    Some(HoldEvent::DoubleTap)
                } else {
                    self.last_tap = Some(now);
                    None
                }
            }
            Phase::Guarding(_) if keys.other => {
                self.phase = Phase::Spoiled;
                None
            }
            Phase::Guarding(since) if now.duration_since(since) >= GUARD => {
                self.phase = Phase::Holding;
                self.last_tap = None;
                Some(HoldEvent::Started)
            }
            Phase::Guarding(_) => None,
            Phase::Holding if !keys.held => {
                self.phase = Phase::Up;
                Some(HoldEvent::Ended)
            }
            Phase::Holding if keys.other => {
                self.phase = Phase::Spoiled;
                Some(HoldEvent::Cancelled)
            }
            Phase::Holding => None,
            Phase::Spoiled if !keys.held => {
                self.phase = Phase::Up;
                self.last_tap = None;
                None
            }
            Phase::Spoiled => None,
        }
    }

    /// Both keys are down (guarding or holding): the reader polls faster, and checks other keys.
    pub fn keys_down(&self) -> bool {
        matches!(self.phase, Phase::Guarding(_) | Phase::Holding)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HELD: Keys = Keys {
        held: true,
        other: false,
    };
    const UP: Keys = Keys {
        held: false,
        other: false,
    };
    const HELD_WITH_KEY: Keys = Keys {
        held: true,
        other: true,
    };

    /// Runs `polls` (milliseconds from the start, keys) and collects the events.
    fn run(polls: &[(u64, Keys)]) -> Vec<HoldEvent> {
        let start = Instant::now();
        let mut gesture = HoldGesture::default();
        polls
            .iter()
            .filter_map(|&(ms, keys)| gesture.step(keys, start + Duration::from_millis(ms)))
            .collect()
    }

    #[test]
    fn a_hold_starts_after_the_guard_and_ends_when_the_keys_come_up() {
        let events = run(&[
            (0, HELD),
            (150, HELD),
            (299, HELD),
            (300, HELD),
            (2_000, UP),
        ]);
        assert_eq!(events, [HoldEvent::Started, HoldEvent::Ended]);
        // Coarse polling: the first poll past the guard starts it.
        assert_eq!(
            run(&[(0, HELD), (450, HELD), (900, UP)]),
            [HoldEvent::Started, HoldEvent::Ended]
        );
    }

    #[test]
    fn altgr_style_typing_never_starts_anything() {
        // Ctrl+Alt+E for "€", Ctrl+Alt+Q for "@": a key comes within the guard.
        assert!(run(&[(0, HELD), (80, HELD_WITH_KEY), (120, HELD), (200, UP)]).is_empty());
        // The key came first (held before the two modifiers).
        assert!(run(&[
            (0, HELD_WITH_KEY),
            (400, HELD_WITH_KEY),
            (900, HELD),
            (1_200, UP)
        ])
        .is_empty());
        // Holding on after the key doesn't start it either: only a fresh press does.
        assert!(run(&[
            (0, HELD),
            (50, HELD_WITH_KEY),
            (60, HELD),
            (1_000, HELD),
            (2_000, UP)
        ])
        .is_empty());
        // Typed slowly: the hold had started; the key cancels it, silently.
        assert_eq!(
            run(&[(0, HELD), (350, HELD), (500, HELD_WITH_KEY), (600, UP)]),
            [HoldEvent::Started, HoldEvent::Cancelled]
        );
    }

    #[test]
    fn two_quick_taps_toggle_draw_mode() {
        let events = run(&[(0, HELD), (90, UP), (300, HELD), (380, UP)]);
        assert_eq!(events, [HoldEvent::DoubleTap]);
        // Three taps: one double tap, then a single one.
        let events = run(&[
            (0, HELD),
            (90, UP),
            (300, HELD),
            (380, UP),
            (600, HELD),
            (680, UP),
        ]);
        assert_eq!(events, [HoldEvent::DoubleTap]);
    }

    #[test]
    fn taps_too_far_apart_or_with_a_key_are_not_a_double_tap() {
        assert!(run(&[(0, HELD), (90, UP), (600, HELD), (680, UP)]).is_empty());
        // A key during the first tap spoils it.
        assert!(run(&[
            (0, HELD),
            (40, HELD_WITH_KEY),
            (90, UP),
            (200, HELD),
            (260, UP)
        ])
        .is_empty());
        // A tap then a hold: the hold, not a double tap.
        assert_eq!(
            run(&[(0, HELD), (90, UP), (250, HELD), (600, HELD), (900, UP)]),
            [HoldEvent::Started, HoldEvent::Ended]
        );
    }

    #[test]
    fn says_when_the_keys_are_down() {
        let start = Instant::now();
        let mut gesture = HoldGesture::default();
        assert!(!gesture.keys_down());
        gesture.step(HELD, start);
        assert!(gesture.keys_down());
        gesture.step(HELD, start + GUARD);
        assert!(gesture.keys_down());
        gesture.step(UP, start + GUARD * 2);
        assert!(!gesture.keys_down());
    }
}
