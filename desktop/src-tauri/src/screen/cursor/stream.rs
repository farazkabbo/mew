//! The input stream (A): raw mouse positions from the hook, at whatever rate the device sends
//! them, resampled to a steady 120 Hz, smoothed with the One Euro filter, with velocity and
//! acceleration. Positions are physical pixels on the virtual desktop (negative left of or above
//! the primary monitor). Nothing here is stored: each sample replaces the last.

use super::euro::{EuroParams, OneEuro};

pub const RATE_HZ: f64 = 120.0;
pub const STEP_MS: f64 = 1000.0 / RATE_HZ;
/// A gap longer than this between raw samples is rest, not a slow movement: the clock restarts.
const MAX_GAP_MS: f64 = 250.0;

/// One raw position from the hook (`t_ms`: a monotonic clock in milliseconds).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RawSample {
    pub t_ms: f64,
    pub x: f64,
    pub y: f64,
}

/// One 120 Hz sample: filtered position, velocity (px/s) and acceleration (px/s²).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Kin {
    pub t_ms: f64,
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub ax: f64,
    pub ay: f64,
}

impl Kin {
    pub fn speed(&self) -> f64 {
        self.vx.hypot(self.vy)
    }
    /// Acceleration along the direction of travel (negative: slowing down).
    pub fn along(&self) -> f64 {
        let s = self.speed();
        if s < 1e-6 {
            0.0
        } else {
            (self.ax * self.vx + self.ay * self.vy) / s
        }
    }
}

#[derive(Debug, Clone)]
pub struct Stream {
    fx: OneEuro,
    fy: OneEuro,
    last_raw: Option<RawSample>,
    next_t: f64,
    prev: Option<Kin>,
}

impl Stream {
    pub fn new(params: EuroParams) -> Self {
        Self {
            fx: OneEuro::new(params),
            fy: OneEuro::new(params),
            last_raw: None,
            next_t: 0.0,
            prev: None,
        }
    }

    pub fn reset(&mut self) {
        self.fx.reset();
        self.fy.reset();
        self.last_raw = None;
        self.prev = None;
    }

    pub fn last(&self) -> Option<Kin> {
        self.prev
    }

    /// Adds a raw sample; the 120 Hz samples it completes go to `out`.
    pub fn push(&mut self, raw: RawSample, out: &mut Vec<Kin>) {
        let Some(last) = self.last_raw else {
            self.last_raw = Some(raw);
            self.next_t = raw.t_ms;
            self.emit(raw.t_ms, raw.x, raw.y, out);
            self.next_t = raw.t_ms + STEP_MS;
            return;
        };
        if raw.t_ms <= last.t_ms {
            // Same timestamp (several hook events in one tick): keep the newest position.
            self.last_raw = Some(RawSample {
                t_ms: last.t_ms,
                ..raw
            });
            return;
        }
        if raw.t_ms - last.t_ms > MAX_GAP_MS {
            // Rest: hold the old position up to now, then restart from here.
            self.hold_until(last, raw.t_ms - STEP_MS, out);
            self.next_t = raw.t_ms;
        }
        while self.next_t <= raw.t_ms {
            let k = ((self.next_t - last.t_ms) / (raw.t_ms - last.t_ms)).clamp(0.0, 1.0);
            let x = last.x + (raw.x - last.x) * k;
            let y = last.y + (raw.y - last.y) * k;
            self.emit(self.next_t, x, y, out);
            self.next_t += STEP_MS;
        }
        self.last_raw = Some(raw);
    }

    /// No raw sample came (the mouse is still): samples at the last position up to `now_ms`, so
    /// the predictor sees the movement end.
    pub fn tick(&mut self, now_ms: f64, out: &mut Vec<Kin>) {
        if let Some(last) = self.last_raw {
            self.hold_until(last, now_ms, out);
        }
    }

    fn hold_until(&mut self, at: RawSample, until_ms: f64, out: &mut Vec<Kin>) {
        // At most a quarter second of held samples: after that it's at rest anyway.
        let cap = self.next_t + MAX_GAP_MS;
        while self.next_t <= until_ms && self.next_t <= cap {
            self.emit(self.next_t, at.x, at.y, out);
            self.next_t += STEP_MS;
        }
        if self.next_t <= until_ms {
            self.next_t = until_ms + STEP_MS;
        }
    }

    fn emit(&mut self, t_ms: f64, x: f64, y: f64, out: &mut Vec<Kin>) {
        let t = t_ms / 1000.0;
        let (x, y) = (self.fx.filter(t, x), self.fy.filter(t, y));
        let kin = match self.prev {
            Some(p) if t_ms > p.t_ms => {
                let dt = (t_ms - p.t_ms) / 1000.0;
                let (vx, vy) = ((x - p.x) / dt, (y - p.y) / dt);
                // Acceleration from a lightly smoothed velocity difference.
                let (ax, ay) = ((vx - p.vx) / dt, (vy - p.vy) / dt);
                Kin {
                    t_ms,
                    x,
                    y,
                    vx,
                    vy,
                    ax: p.ax + 0.5 * (ax - p.ax),
                    ay: p.ay + 0.5 * (ay - p.ay),
                }
            }
            _ => Kin {
                t_ms,
                x,
                y,
                ..Kin::default()
            },
        };
        self.prev = Some(kin);
        out.push(kin);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_an_uneven_device_to_120_hz() {
        let mut s = Stream::new(EuroParams::default());
        let mut out = Vec::new();
        // A 125 Hz mouse with jittery timing, moving right at 600 px/s.
        let mut t = 0.0;
        for i in 0..250 {
            t += if i % 3 == 0 { 9.0 } else { 7.5 };
            s.push(
                RawSample {
                    t_ms: t,
                    x: 0.6 * t,
                    y: -300.0,
                },
                &mut out,
            );
        }
        let gaps: Vec<f64> = out.windows(2).map(|w| w[1].t_ms - w[0].t_ms).collect();
        assert!(gaps.iter().all(|g| (g - STEP_MS).abs() < 1e-6), "{gaps:?}");
        let last = out.last().unwrap();
        assert!((last.vx - 600.0).abs() < 15.0, "vx {}", last.vx);
        assert!(last.vy.abs() < 1.0);
        // Negative coordinates (a monitor above the primary) are just numbers.
        assert!((last.y + 300.0).abs() < 1e-6);
    }

    #[test]
    fn rest_is_seen_as_rest() {
        let mut s = Stream::new(EuroParams::default());
        let mut out = Vec::new();
        for i in 0..60 {
            let t = i as f64 * 8.0;
            s.push(
                RawSample {
                    t_ms: t,
                    x: t,
                    y: 0.0,
                },
                &mut out,
            );
        }
        out.clear();
        s.tick(472.0 + 200.0, &mut out);
        assert!(!out.is_empty());
        assert!(out.last().unwrap().speed() < 50.0);
        // A long gap then a new movement restarts cleanly without thousands of samples.
        out.clear();
        s.push(
            RawSample {
                t_ms: 60_000.0,
                x: 5.0,
                y: 5.0,
            },
            &mut out,
        );
        assert!(out.len() < 40, "{}", out.len());
    }

    #[test]
    fn a_sample_costs_well_under_a_millisecond() {
        let mut s = Stream::new(EuroParams::default());
        let mut out = Vec::with_capacity(4);
        let started = std::time::Instant::now();
        for i in 0..100_000 {
            out.clear();
            let t = i as f64 * 8.0;
            s.push(
                RawSample {
                    t_ms: t,
                    x: (t * 0.01).sin() * 400.0,
                    y: t * 0.1,
                },
                &mut out,
            );
        }
        let per = started.elapsed().as_secs_f64() * 1000.0 / 100_000.0;
        assert!(per < 0.05, "{per} ms per sample");
    }
}
