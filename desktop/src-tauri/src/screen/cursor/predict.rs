//! Endpoint prediction (C): where is this pointer movement going to stop?
//!
//! A movement starts when the speed rises above `start_speed` after rest and ends when it stays
//! below `end_speed` (or a click). While it runs, an `EndpointModel` estimates the total distance
//! from the speed profile so far. The first model is minimum-jerk (Flash & Hogan, 1985): the speed
//! of an aimed movement follows v(t) = D/T · 30τ²(1−τ)², τ = t/T. Given the samples so far, D and T
//! are fitted by least squares (D in closed form for each T on a grid), and the endpoint is the
//! remaining distance laid along the current heading. `EndpointModel` is the plug for kinematic
//! template matching later.
//!
//! Motion alone isn't enough to pick between neighbouring menu items (published KTM error is
//! ~48 px at 75 % of the movement); `posterior.rs` combines it with what Neb expects.

use super::stream::Kin;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PredictParams {
    /// px/s: above this after rest, a movement has started.
    pub start_speed: f64,
    /// px/s: below this for `end_ms`, it has ended.
    pub end_speed: f64,
    pub end_ms: f64,
    /// Ignore movements shorter than this (px) for prediction.
    pub min_distance: f64,
}

impl Default for PredictParams {
    fn default() -> Self {
        Self {
            start_speed: 80.0,
            end_speed: 40.0,
            end_ms: 60.0,
            min_distance: 40.0,
        }
    }
}

/// The current movement's samples since it started (at most a few seconds' worth).
#[derive(Debug, Clone, Default)]
pub struct Movement {
    pub samples: Vec<Kin>,
    /// Path length travelled so far, px.
    pub travelled: f64,
    pub peak_speed: f64,
}

impl Movement {
    pub fn start(&self) -> Option<&Kin> {
        self.samples.first()
    }
    pub fn now(&self) -> Option<&Kin> {
        self.samples.last()
    }
    pub fn elapsed_ms(&self) -> f64 {
        match (self.samples.first(), self.samples.last()) {
            (Some(a), Some(b)) => b.t_ms - a.t_ms,
            _ => 0.0,
        }
    }
    /// The heading now: the blend of the overall direction and the last ~50 ms.
    pub fn heading(&self) -> Option<(f64, f64)> {
        let (start, now) = (self.start()?, self.now()?);
        let overall = unit(now.x - start.x, now.y - start.y)?;
        let recent = self
            .samples
            .iter()
            .rev()
            .find(|k| now.t_ms - k.t_ms >= 50.0)
            .and_then(|k| unit(now.x - k.x, now.y - k.y))
            .unwrap_or(overall);
        unit(overall.0 + recent.0, overall.1 + recent.1)
    }
}

fn unit(x: f64, y: f64) -> Option<(f64, f64)> {
    let l = x.hypot(y);
    (l > 1e-6).then(|| (x / l, y / l))
}

/// What a model says about the movement now.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Prediction {
    pub endpoint: (f64, f64),
    /// Estimated total path length, px.
    pub distance: f64,
    /// travelled / distance, 0..1.
    pub progress: f64,
    /// Estimated total duration, ms.
    pub duration_ms: f64,
}

pub trait EndpointModel {
    fn predict(&self, movement: &Movement) -> Option<Prediction>;
}

/// Minimum-jerk fit of the speed profile.
#[derive(Debug, Clone, Copy, Default)]
pub struct MinJerk;

/// Normalised minimum-jerk speed shape at τ (peak 1.875 at τ = 0.5).
fn shape(tau: f64) -> f64 {
    if !(0.0..=1.0).contains(&tau) {
        return 0.0;
    }
    30.0 * tau * tau * (1.0 - tau) * (1.0 - tau)
}

/// Normalised minimum-jerk position at τ (0 → 1).
fn position(tau: f64) -> f64 {
    let tau = tau.clamp(0.0, 1.0);
    tau * tau * tau * (10.0 - 15.0 * tau + 6.0 * tau * tau)
}

impl EndpointModel for MinJerk {
    fn predict(&self, movement: &Movement) -> Option<Prediction> {
        let (start, now) = (movement.start()?, movement.now()?);
        let elapsed = (now.t_ms - start.t_ms) / 1000.0;
        if movement.samples.len() < 6 || elapsed <= 0.0 {
            return None;
        }
        // The movement is noticed a little after it really began (once it's faster than the
        // start threshold), so the onset is fitted too: up to 80 ms before it was noticed.
        // For each onset and each T on a grid, D comes in closed form; the best residual wins.
        let fit = |onset: f64, t_total: f64| -> Option<(f64, f64)> {
            let (mut sf, mut ff, mut vv) = (0.0, 0.0, 0.0);
            for k in &movement.samples {
                let tau = ((k.t_ms - start.t_ms) / 1000.0 + onset) / t_total;
                let f = shape(tau) / t_total;
                let v = k.speed();
                sf += v * f;
                ff += f * f;
                vv += v * v;
            }
            (ff > 0.0).then(|| {
                let d = sf / ff;
                (vv - 2.0 * d * sf + d * d * ff, d)
            })
        };
        let mut best: Option<(f64, f64, f64, f64)> = None; // (residual, D, T, onset)
        let consider = |best: &mut Option<(f64, f64, f64, f64)>, onset: f64, t_total: f64| {
            if let Some((residual, d)) = fit(onset, t_total) {
                if best.is_none_or(|(r, ..)| residual < r) {
                    *best = Some((residual, d, t_total, onset));
                }
            }
        };
        // Coarse: 9 onsets × 40 durations.
        let mut step = 0.0;
        for o in 0..9 {
            let onset = f64::from(o) * 0.010;
            let since = elapsed + onset;
            let t_lo = since * 1.02;
            let t_hi = (since * 4.0).clamp(t_lo + 0.01, 2.5);
            step = (t_hi - t_lo) / 39.0;
            for i in 0..40 {
                consider(&mut best, onset, t_lo + step * f64::from(i));
            }
        }
        // Fine: around the best, onset ±5 ms and duration ±1 coarse step.
        let (_, _, t0, o0) = best?;
        for o in -2..=2 {
            let onset = (o0 + f64::from(o) * 0.0025).max(0.0);
            for i in -10..=10 {
                let t_total = t0 + step * f64::from(i) / 10.0;
                if t_total > elapsed + onset {
                    consider(&mut best, onset, t_total);
                }
            }
        }
        let (_, d, t_total, onset) = best?;
        // Where the fitted profile says we are, and what's left of it.
        let tau_now = (elapsed + onset) / t_total;
        let done = position(tau_now);
        let remaining = (d * (1.0 - done)).max(0.0);
        let distance = (movement.travelled + remaining).max(1.0);
        let (hx, hy) = movement.heading()?;
        Some(Prediction {
            endpoint: (now.x + hx * remaining, now.y + hy * remaining),
            distance,
            progress: (movement.travelled / distance).clamp(0.0, 1.0),
            duration_ms: (t_total - onset) * 1000.0,
        })
    }
}

/// Splits the 120 Hz stream into movements.
#[derive(Debug, Clone, Default)]
pub struct Segmenter {
    params: PredictParams,
    current: Option<Movement>,
    slow_since: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Phase {
    Rest,
    Moving,
    /// The movement just ended (once).
    Ended,
}

impl Segmenter {
    pub fn new(params: PredictParams) -> Self {
        Self {
            params,
            ..Self::default()
        }
    }

    pub fn movement(&self) -> Option<&Movement> {
        self.current.as_ref()
    }

    /// Long enough to be worth predicting.
    pub fn substantial(&self) -> bool {
        self.current
            .as_ref()
            .is_some_and(|m| m.peak_speed > self.params.start_speed * 2.0 && m.samples.len() >= 6)
            && self
                .current
                .as_ref()
                .is_some_and(|m| m.travelled >= self.params.min_distance * 0.25)
    }

    pub fn push(&mut self, k: Kin) -> Phase {
        let speed = k.speed();
        match self.current.as_mut() {
            None => {
                if speed >= self.params.start_speed {
                    self.current = Some(Movement {
                        samples: vec![k],
                        travelled: 0.0,
                        peak_speed: speed,
                    });
                    self.slow_since = None;
                    Phase::Moving
                } else {
                    Phase::Rest
                }
            }
            Some(m) => {
                if let Some(prev) = m.samples.last() {
                    m.travelled += (k.x - prev.x).hypot(k.y - prev.y);
                }
                m.peak_speed = m.peak_speed.max(speed);
                // A movement is at most 3 s: older samples aren't the same aim.
                if m.samples.len() < 360 {
                    m.samples.push(k);
                }
                if speed < self.params.end_speed {
                    let since = *self.slow_since.get_or_insert(k.t_ms);
                    if k.t_ms - since >= self.params.end_ms {
                        self.current = None;
                        self.slow_since = None;
                        return Phase::Ended;
                    }
                } else {
                    self.slow_since = None;
                }
                Phase::Moving
            }
        }
    }

    /// A click ends the movement.
    pub fn end(&mut self) {
        self.current = None;
        self.slow_since = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A straight minimum-jerk movement sampled at 120 Hz.
    pub fn min_jerk(from: (f64, f64), to: (f64, f64), ms: f64) -> Vec<Kin> {
        let n = (ms / (1000.0 / 120.0)).round() as usize;
        let (dx, dy) = (to.0 - from.0, to.1 - from.1);
        let d = dx.hypot(dy);
        (0..=n)
            .map(|i| {
                let tau = i as f64 / n as f64;
                let s = 10.0 * tau.powi(3) - 15.0 * tau.powi(4) + 6.0 * tau.powi(5);
                let v = d / (ms / 1000.0) * shape(tau);
                Kin {
                    t_ms: i as f64 * 1000.0 / 120.0,
                    x: from.0 + dx * s,
                    y: from.1 + dy * s,
                    vx: v * dx / d,
                    vy: v * dy / d,
                    ..Kin::default()
                }
            })
            .collect()
    }

    #[test]
    fn an_ideal_movement_is_predicted_from_its_middle_on() {
        let samples = min_jerk((100.0, 900.0), (700.0, 500.0), 600.0);
        let mut seg = Segmenter::new(PredictParams::default());
        let mut errors = Vec::new();
        for k in &samples {
            if seg.push(*k) == Phase::Moving {
                if let Some(p) = seg.movement().and_then(|m| MinJerk.predict(m)) {
                    let frac = k.t_ms / 600.0;
                    if frac >= 0.5 {
                        errors.push((p.endpoint.0 - 700.0).hypot(p.endpoint.1 - 500.0));
                    }
                }
            }
        }
        assert!(!errors.is_empty());
        let worst = errors.iter().cloned().fold(0.0, f64::max);
        assert!(worst < 25.0, "worst {worst}, {errors:?}");
    }

    #[test]
    fn rest_ends_a_movement() {
        let mut seg = Segmenter::new(PredictParams::default());
        let samples = min_jerk((0.0, 0.0), (300.0, 0.0), 400.0);
        let last = *samples.last().unwrap();
        let mut ended = false;
        for k in samples {
            seg.push(k);
        }
        for i in 1..20 {
            let k = Kin {
                t_ms: last.t_ms + i as f64 * 8.3,
                ..last
            };
            let k = Kin {
                vx: 0.0,
                vy: 0.0,
                ..k
            };
            if seg.push(k) == Phase::Ended {
                ended = true;
                break;
            }
        }
        assert!(ended);
        assert!(seg.movement().is_none());
    }

    #[test]
    fn prediction_is_fast() {
        let samples = min_jerk((0.0, 0.0), (900.0, 300.0), 1200.0);
        let mut seg = Segmenter::new(PredictParams::default());
        for k in &samples[..samples.len() * 3 / 4] {
            seg.push(*k);
        }
        let m = seg.movement().unwrap().clone();
        let started = std::time::Instant::now();
        for _ in 0..200 {
            std::hint::black_box(MinJerk.predict(&m));
        }
        let per = started.elapsed().as_secs_f64() * 1000.0 / 200.0;
        // Release builds (what ships) stay well under a millisecond; debug builds are ~10× slower.
        let budget = if cfg!(debug_assertions) { 5.0 } else { 1.0 };
        assert!(per < budget, "{per} ms per prediction");
    }
}
