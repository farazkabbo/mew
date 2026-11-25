//! Motion plus intent (C): which target is the pointer going to?
//!
//! P(target | motion) ∝ N(distance from the predicted endpoint to the target's rectangle; σ) ×
//! prior(target). σ shrinks as the movement nears its end (σ = σ_min + k · remaining distance).
//! The prior comes from what Neb expects: the current SHOW ME step's target gets most of it, or,
//! for CATCH ME, every target gets the same. A "none of these" hypothesis with a fixed likelihood
//! keeps a movement into empty space from being pinned on the nearest control.
//!
//! The trigger then decides whether to speak up, once per movement, only late in it and while it
//! slows: SHOW ME when the student is clearly heading for the wrong control; CATCH ME when they're
//! heading for a risky one. Every threshold is a config value (`TriggerParams`).

use serde::{Deserialize, Serialize};

use super::predict::Prediction;
use super::stream::Kin;
use super::target::Target;
use crate::screen::frame::ScreenRect;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase", default)]
pub struct TriggerParams {
    /// SHOW ME: only at or past this fraction of the movement.
    pub min_progress: f64,
    /// SHOW ME: the wrong target must be at least this likely…
    pub p_wrong: f64,
    /// …and the expected one at most this likely.
    pub p_expected_max: f64,
    /// CATCH ME: speak up at or past this fraction of the movement…
    pub catch_progress: f64,
    /// …when a risky target is at least this likely.
    pub p_risky: f64,
    /// σ in px: σ_min + sigma_per_px · remaining distance, at most sigma_max.
    pub sigma_min: f64,
    pub sigma_per_px: f64,
    pub sigma_max: f64,
    /// The share of the prior the expected target gets (SHOW ME).
    pub expected_prior: f64,
    /// "None of these": its likelihood is that of a target this many σ away.
    pub none_at_sigmas: f64,
    /// Shorter movements are never interrupted (px).
    pub min_distance: f64,
    /// Slowing down: the speed now is under this share of the movement's peak.
    pub slowing: f64,
    /// The wrong target must have been the likeliest for this many frames in a row (120 Hz).
    pub stable_frames: u32,
}

impl Default for TriggerParams {
    fn default() -> Self {
        // Tuned on the replay harness (`trace.rs`); see docs/CURSOR_MODES.md for the numbers.
        Self {
            min_progress: 0.7,
            p_wrong: 0.8,
            p_expected_max: 0.1,
            catch_progress: 0.6,
            p_risky: 0.6,
            sigma_min: 10.0,
            sigma_per_px: 0.25,
            sigma_max: 200.0,
            expected_prior: 0.5,
            none_at_sigmas: 2.5,
            min_distance: 120.0,
            slowing: 0.85,
            stable_frames: 3,
        }
    }
}

impl TriggerParams {
    pub fn check(&self) -> Result<(), String> {
        let unit = |v: f64| (0.0..=1.0).contains(&v);
        let ok = unit(self.min_progress)
            && unit(self.p_wrong)
            && unit(self.p_expected_max)
            && unit(self.catch_progress)
            && unit(self.p_risky)
            && unit(self.expected_prior)
            && unit(self.slowing)
            && self.sigma_min > 0.0
            && self.sigma_max >= self.sigma_min
            && self.sigma_per_px >= 0.0
            && self.none_at_sigmas > 0.0
            && self.min_distance >= 0.0
            && self.stable_frames <= 60;
        ok.then_some(())
            .ok_or_else(|| "Those cursor thresholds aren't valid.".to_owned())
    }

    pub fn sigma(&self, prediction: &Prediction) -> f64 {
        let remaining = prediction.distance * (1.0 - prediction.progress);
        (self.sigma_min + self.sigma_per_px * remaining).min(self.sigma_max)
    }
}

/// Distance from a point to a rectangle (0 inside).
pub fn distance_to(rect: ScreenRect, (x, y): (f64, f64)) -> f64 {
    let dx = (f64::from(rect.left) - x)
        .max(0.0)
        .max(x - f64::from(rect.right));
    let dy = (f64::from(rect.top) - y)
        .max(0.0)
        .max(y - f64::from(rect.bottom));
    dx.hypot(dy)
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Posterior {
    /// (target id, probability), most likely first.
    pub ranked: Vec<(u32, f64)>,
    pub none: f64,
}

impl Posterior {
    pub fn of(&self, id: u32) -> f64 {
        self.ranked
            .iter()
            .find(|(t, _)| *t == id)
            .map_or(0.0, |(_, p)| *p)
    }
    pub fn top(&self) -> Option<(u32, f64)> {
        self.ranked.first().copied()
    }
}

/// What Neb expects the student to click (a prior over targets).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Prior {
    /// Every target the same (motion only).
    Uniform,
    /// SHOW ME: this target gets `expected_prior` of the mass.
    Expect(u32),
}

pub fn posterior(
    prediction: &Prediction,
    targets: &[Target],
    prior: Prior,
    params: &TriggerParams,
) -> Posterior {
    let sigma = params.sigma(prediction);
    let gauss = |d: f64| (-(d * d) / (2.0 * sigma * sigma)).exp();
    let n = targets.len().max(1) as f64;
    let prior_of = |t: &Target| match prior {
        Prior::Uniform => 1.0 / n,
        Prior::Expect(id) if t.id == id => params.expected_prior,
        Prior::Expect(_) => (1.0 - params.expected_prior) / (n - 1.0).max(1.0),
    };
    let mut ranked: Vec<(u32, f64)> = targets
        .iter()
        .map(|t| {
            (
                t.id,
                gauss(distance_to(t.rect, prediction.endpoint)) * prior_of(t),
            )
        })
        .collect();
    let none = gauss(params.none_at_sigmas * sigma) * (1.0 / n);
    let total: f64 = ranked.iter().map(|(_, p)| p).sum::<f64>() + none;
    if total > 0.0 {
        for (_, p) in &mut ranked {
            *p /= total;
        }
    }
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    Posterior {
        ranked,
        none: if total > 0.0 { none / total } else { 1.0 },
    }
}

/// Is the movement slowing down now?
pub fn slowing(now: &Kin, peak_speed: f64, params: &TriggerParams) -> bool {
    now.speed() < params.slowing * peak_speed && now.along() <= 0.0
}

/// Latches one decision per movement.
#[derive(Debug, Clone, Default)]
pub struct Trigger {
    fired: bool,
    /// The candidate and for how many frames in a row it has held.
    streak: Option<(u32, u32)>,
}

impl Trigger {
    /// A new movement began.
    pub fn reset(&mut self) {
        self.fired = false;
        self.streak = None;
    }

    /// Counts `candidate` (None: the conditions don't hold this frame); true once it has held
    /// for `frames` frames in a row.
    fn held(&mut self, candidate: Option<u32>, frames: u32) -> bool {
        self.streak = match (candidate, self.streak) {
            (None, _) => None,
            (Some(c), Some((s, n))) if s == c => Some((c, n + 1)),
            (Some(c), _) => Some((c, 1)),
        };
        self.streak.is_some_and(|(_, n)| n >= frames.max(1))
    }

    /// SHOW ME: the wrong target the student is heading for, once, when every condition has
    /// held for `stable_frames` frames.
    pub fn wrong_target(
        &mut self,
        prediction: &Prediction,
        now: &Kin,
        peak_speed: f64,
        post: &Posterior,
        expected: u32,
        params: &TriggerParams,
    ) -> Option<u32> {
        if self.fired {
            return None;
        }
        let candidate = (prediction.progress >= params.min_progress
            && prediction.distance >= params.min_distance
            && slowing(now, peak_speed, params)
            && post.of(expected) <= params.p_expected_max)
            .then(|| post.top())
            .flatten()
            .filter(|(top, p)| *top != expected && *p >= params.p_wrong)
            .map(|(top, _)| top);
        if self.held(candidate, params.stable_frames) {
            self.fired = true;
            return candidate;
        }
        None
    }

    /// CATCH ME: the risky target the student is heading for, once. (A rule made less eager in
    /// an app passes `params` with a higher `p_risky`.)
    pub fn risky_target(
        &mut self,
        prediction: &Prediction,
        now: &Kin,
        peak_speed: f64,
        post: &Posterior,
        risky: &[u32],
        params: &TriggerParams,
    ) -> Option<u32> {
        if self.fired {
            return None;
        }
        let candidate = (prediction.progress >= params.catch_progress
            && slowing(now, peak_speed, params))
        .then(|| {
            risky
                .iter()
                .map(|id| (*id, post.of(*id)))
                .filter(|(_, p)| *p >= params.p_risky)
                .max_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(id, _)| id)
        })
        .flatten();
        if self.held(candidate, params.stable_frames) {
            self.fired = true;
            return candidate;
        }
        None
    }
}

/// The one or two words that steer the student to the right target (H).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cue {
    Below,
    Above,
    Left,
    Right,
    NotThatOne,
}

impl Cue {
    pub const ALL: [Cue; 5] = [
        Cue::Below,
        Cue::Above,
        Cue::Left,
        Cue::Right,
        Cue::NotThatOne,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Cue::Below => "below",
            Cue::Above => "above",
            Cue::Left => "left",
            Cue::Right => "right",
            Cue::NotThatOne => "not_that_one",
        }
    }
}

/// Where the right target is from the wrong one: a direction when it's a near neighbour, "not
/// that one" when it's far or the direction is unclear.
pub fn cue(wrong: ScreenRect, right: ScreenRect) -> Cue {
    let (wx, wy) = super::scene::centre(wrong);
    let (rx, ry) = super::scene::centre(right);
    let (dx, dy) = (rx - wx, ry - wy);
    if dx.hypot(dy) > 400.0 {
        return Cue::NotThatOne;
    }
    if dy.abs() > dx.abs() * 1.5 {
        if dy > 0.0 {
            Cue::Below
        } else {
            Cue::Above
        }
    } else if dx.abs() > dy.abs() * 1.5 {
        if dx > 0.0 {
            Cue::Right
        } else {
            Cue::Left
        }
    } else {
        Cue::NotThatOne
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::cursor::target::t;

    fn pred(endpoint: (f64, f64), progress: f64) -> Prediction {
        Prediction {
            endpoint,
            distance: 400.0,
            progress,
            duration_ms: 500.0,
        }
    }

    fn menu() -> Vec<Target> {
        (0..6)
            .map(|i| {
                t(
                    i,
                    &format!("Item {i}"),
                    "MenuItem",
                    (100, 100 + 30 * i as i32, 300, 128 + 30 * i as i32),
                )
            })
            .collect()
    }

    #[test]
    fn motion_alone_cant_split_neighbours_early_but_the_prior_does() {
        let targets = menu();
        let params = TriggerParams::default();
        // Halfway, aiming between items 2 and 3.
        let early = pred((200.0, 189.0), 0.5);
        let motion = posterior(&early, &targets, Prior::Uniform, &params);
        assert!(motion.top().unwrap().1 < 0.5, "{motion:?}");
        let with_prior = posterior(&early, &targets, Prior::Expect(3), &params);
        assert_eq!(with_prior.top().unwrap().0, 3);
    }

    /// A toolbar: buttons 40 px wide with 24 px between them.
    fn toolbar() -> Vec<Target> {
        (0..6)
            .map(|i| {
                t(
                    i,
                    &format!("Tool {i}"),
                    "Button",
                    (100 + 64 * i as i32, 100, 140 + 64 * i as i32, 136),
                )
            })
            .collect()
    }

    #[test]
    fn adjacent_menu_items_never_reach_the_threshold_on_motion_alone() {
        // The spec's thresholds are cautious on purpose: two items 2 px apart can't be told apart
        // well enough to interrupt (that's what the prior and the late expand are for).
        let p = pred((200.0, 114.0), 0.95);
        let post = posterior(&p, &menu(), Prior::Expect(4), &TriggerParams::default());
        assert!(post.of(0) < 0.8);
    }

    #[test]
    fn late_and_slowing_into_the_wrong_item_triggers_once() {
        let targets = toolbar();
        let params = TriggerParams::default();
        // At 95 %, landing squarely on tool 0 while tool 4 is expected.
        let p = pred((120.0, 118.0), 0.95);
        let post = posterior(&p, &targets, Prior::Expect(4), &params);
        let now = Kin {
            vx: 100.0,
            ax: -2000.0,
            ..Kin::default()
        };
        let mut trigger = Trigger::default();
        let fired: Vec<Option<u32>> = (0..6)
            .map(|_| trigger.wrong_target(&p, &now, 1500.0, &post, 4, &params))
            .collect();
        // Not on the first frames (it must hold), then exactly once.
        assert_eq!(fired[..2], [None, None]);
        assert_eq!(fired.iter().filter(|f| **f == Some(0)).count(), 1);
        // Still speeding up: never.
        let mut trigger = Trigger::default();
        let fast = Kin {
            vx: 1500.0,
            ax: 3000.0,
            ..Kin::default()
        };
        for _ in 0..6 {
            assert_eq!(
                trigger.wrong_target(&p, &fast, 1500.0, &post, 4, &params),
                None
            );
        }
    }

    #[test]
    fn empty_space_belongs_to_none() {
        let p = pred((900.0, 900.0), 0.95);
        let post = posterior(&p, &menu(), Prior::Uniform, &TriggerParams::default());
        assert!(post.none > 0.99, "{post:?}");
    }

    #[test]
    fn cues_point_the_right_way() {
        let r = |y: i32, x: i32| ScreenRect {
            left: x,
            top: y,
            right: x + 100,
            bottom: y + 28,
        };
        assert_eq!(cue(r(100, 0), r(160, 0)), Cue::Below);
        assert_eq!(cue(r(160, 0), r(100, 0)), Cue::Above);
        assert_eq!(cue(r(0, 300), r(0, 100)), Cue::Left);
        assert_eq!(cue(r(0, 0), r(900, 900)), Cue::NotThatOne);
    }

    #[test]
    fn thresholds_are_checked() {
        assert!(TriggerParams::default().check().is_ok());
        let bad = TriggerParams {
            p_wrong: 1.5,
            ..TriggerParams::default()
        };
        assert!(bad.check().is_err());
    }
}
