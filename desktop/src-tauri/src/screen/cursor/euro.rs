//! The One Euro filter (Casiez, Roussel & Vogel, CHI 2012): a low-pass filter whose cutoff rises
//! with speed, so a cursor at rest is steady and a fast one isn't lagged.
//!
//! `min_cutoff` (Hz) sets how much jitter is removed at rest; `beta` how quickly the cutoff opens
//! up with speed. Both are config values (`CursorTuning`).

use std::f64::consts::PI;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EuroParams {
    pub min_cutoff: f64,
    pub beta: f64,
    /// Cutoff for the derivative estimate (Hz).
    pub d_cutoff: f64,
}

impl Default for EuroParams {
    fn default() -> Self {
        // Tuned on the synthetic traces at 120 Hz: steady at rest, < 1 sample of lag at 1500 px/s.
        Self {
            min_cutoff: 1.2,
            beta: 0.012,
            d_cutoff: 1.0,
        }
    }
}

/// One axis.
#[derive(Debug, Clone)]
pub struct OneEuro {
    params: EuroParams,
    last: Option<(f64, f64, f64)>, // (t seconds, filtered x, filtered dx)
}

fn alpha(cutoff: f64, dt: f64) -> f64 {
    let tau = 1.0 / (2.0 * PI * cutoff);
    1.0 / (1.0 + tau / dt)
}

impl OneEuro {
    pub fn new(params: EuroParams) -> Self {
        Self { params, last: None }
    }

    pub fn reset(&mut self) {
        self.last = None;
    }

    /// Filters `x` observed at `t` seconds (strictly increasing; a repeat time returns the last
    /// value).
    pub fn filter(&mut self, t: f64, x: f64) -> f64 {
        let Some((t0, x0, dx0)) = self.last else {
            self.last = Some((t, x, 0.0));
            return x;
        };
        let dt = t - t0;
        if dt <= 0.0 {
            return x0;
        }
        let dx = (x - x0) / dt;
        let dx_hat = dx0 + alpha(self.params.d_cutoff, dt) * (dx - dx0);
        let cutoff = self.params.min_cutoff + self.params.beta * dx_hat.abs();
        let x_hat = x0 + alpha(cutoff, dt) * (x - x0);
        self.last = Some((t, x_hat, dx_hat));
        x_hat
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steadies_jitter_at_rest() {
        let mut f = OneEuro::new(EuroParams::default());
        let mut worst: f64 = 0.0;
        for i in 0..240 {
            let noise = if i % 2 == 0 { 1.0 } else { -1.0 };
            let y = f.filter(i as f64 / 120.0, 500.0 + noise);
            if i > 60 {
                worst = worst.max((y - 500.0).abs());
            }
        }
        assert!(worst < 0.2, "jitter left: {worst}");
    }

    #[test]
    fn follows_a_fast_movement_closely() {
        let mut f = OneEuro::new(EuroParams::default());
        let speed = 1500.0; // px/s
        let mut lag: f64 = 0.0;
        for i in 0..120 {
            let t = i as f64 / 120.0;
            let y = f.filter(t, speed * t);
            if i > 30 {
                lag = lag.max(speed * t - y);
            }
        }
        // Under ~1.5 samples of movement (12.5 px each).
        assert!(lag < 20.0, "lag {lag}");
    }

    #[test]
    fn a_repeated_timestamp_is_harmless() {
        let mut f = OneEuro::new(EuroParams::default());
        f.filter(0.0, 1.0);
        let a = f.filter(0.1, 2.0);
        assert_eq!(f.filter(0.1, 50.0), a);
    }
}
