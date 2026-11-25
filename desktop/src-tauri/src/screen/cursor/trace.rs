//! Mouse traces and the replay harness (M2): record a movement as JSON, replay it through the
//! same engine, posterior and trigger the app runs, and measure.
//!
//! A trace is the raw samples of one aimed movement ending in a click, the targets on screen
//! (rectangles only) and which one was clicked; with `expected`, the target Neb was guiding to.
//! Recorded traces (the debug view's "record traces" switch) contain positions and rectangles
//! only: no names, no window, no content.
//!
//! Until there are recorded traces, a synthetic set stands in: aimed movements built the way
//! people move (Fitts' law timing, a minimum-jerk primary submovement that undershoots or
//! overshoots by a few percent with some angular error, a corrective submovement, hand tremor,
//! and the uneven timing of a 125 Hz mouse or a ~90 Hz touchpad). The numbers it gives are a
//! baseline, not a claim about real people.

use serde::{Deserialize, Serialize};

use super::engine::{Engine, Input};
use super::euro::EuroParams;
use super::posterior::{posterior, Prior, Trigger, TriggerParams};
use super::predict::Prediction;
use super::target::{Source, Target};
use crate::screen::frame::ScreenRect;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Device {
    Mouse,
    Touchpad,
    Synthetic,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Trace {
    pub version: u32,
    pub device: Device,
    /// [t_ms, x, y], from rest to the click.
    pub samples: Vec<[f64; 3]>,
    /// [left, top, right, bottom] of each target on screen.
    pub targets: Vec<[i32; 4]>,
    /// The index of the target clicked.
    pub clicked: usize,
    /// The index of the target Neb expected (SHOW ME), if any.
    #[serde(default)]
    pub expected: Option<usize>,
}

impl Trace {
    pub fn targets(&self) -> Vec<Target> {
        self.targets
            .iter()
            .enumerate()
            .map(|(i, r)| Target {
                id: i as u32,
                name: String::new(),
                control_type: "Button".into(),
                automation_id: String::new(),
                rect: ScreenRect {
                    left: r[0],
                    top: r[1],
                    right: r[2],
                    bottom: r[3],
                },
                source: Source::Uia,
            })
            .collect()
    }

    pub fn click_point(&self) -> (f64, f64) {
        let last = self.samples.last().copied().unwrap_or_default();
        (last[1], last[2])
    }

    /// Parses a recorded trace, refusing anything malformed (it's a file on disk).
    pub fn parse(text: &str) -> Option<Trace> {
        let trace: Trace = serde_json::from_str(text).ok()?;
        let ok = trace.version == 1
            && trace.samples.len() >= 4
            && trace.samples.len() <= 4000
            && trace.clicked < trace.targets.len()
            && trace.expected.is_none_or(|e| e < trace.targets.len())
            && trace.targets.len() <= 600
            && trace.samples.windows(2).all(|w| w[1][0] >= w[0][0]);
        ok.then_some(trace)
    }
}

/// What replaying one trace found.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Replay {
    /// Endpoint error (px) at 50, 75 and 90 % of the movement's duration, where predicted.
    pub error_at: [Option<f64>; 3],
    /// The likeliest target at 90 % with motion only, and with the expected target's prior.
    pub top_motion: Option<u32>,
    pub top_prior: Option<u32>,
    /// SHOW ME's trigger fired (with `expected`), and on which target.
    pub fired: Option<u32>,
    /// Frames replayed and their total pipeline time (ms).
    pub frames: u32,
    pub pipeline_ms: f64,
}

/// Replays `trace` through the engine at the device's own timing, one frame per 8.33 ms.
pub fn replay(trace: &Trace, params: &TriggerParams) -> Replay {
    let mut engine = Engine::new(EuroParams::default());
    let targets = trace.targets();
    let mut trigger = Trigger::default();
    let mut out = Replay::default();
    let (t0, t1) = (
        trace.samples[0][0],
        trace.samples[trace.samples.len() - 1][0],
    );
    let duration = (t1 - t0).max(1.0);
    let (cx, cy) = trace.click_point();
    let marks = [0.5, 0.75, 0.9];
    let mut next = 0;
    let mut frame_end = t0;
    let mut inputs = Vec::new();
    let mut last_prediction: Option<Prediction> = None;
    while next < trace.samples.len() {
        frame_end += 1000.0 / 120.0;
        inputs.clear();
        while next < trace.samples.len() && trace.samples[next][0] <= frame_end {
            let [t_ms, x, y] = trace.samples[next];
            inputs.push(if next + 1 == trace.samples.len() {
                Input::Down { t_ms, x, y }
            } else {
                Input::Move { t_ms, x, y }
            });
            next += 1;
        }
        inputs.push(Input::Tick { t_ms: frame_end });
        let started = std::time::Instant::now();
        let update = engine.feed(&inputs);
        if let (Some(p), Some(kin)) = (update.prediction, update.kin) {
            last_prediction = Some(p);
            let frac = (kin.t_ms - t0) / duration;
            for (i, mark) in marks.iter().enumerate() {
                if out.error_at[i].is_none() && frac >= *mark {
                    out.error_at[i] = Some((p.endpoint.0 - cx).hypot(p.endpoint.1 - cy));
                }
            }
            if let Some(expected) = trace.expected {
                let post = posterior(&p, &targets, Prior::Expect(expected as u32), params);
                if out.fired.is_none() {
                    out.fired = trigger.wrong_target(
                        &p,
                        &kin,
                        update.peak_speed,
                        &post,
                        expected as u32,
                        params,
                    );
                }
            }
            if frac >= 0.9 && out.top_motion.is_none() {
                out.top_motion = posterior(&p, &targets, Prior::Uniform, params)
                    .top()
                    .map(|t| t.0);
                out.top_prior = trace.expected.and_then(|e| {
                    posterior(&p, &targets, Prior::Expect(e as u32), params)
                        .top()
                        .map(|t| t.0)
                });
            }
        }
        out.pipeline_ms += started.elapsed().as_secs_f64() * 1000.0;
        out.frames += 1;
    }
    // Movements predicted only right at the end still get a 90 % verdict.
    if out.top_motion.is_none() {
        if let Some(p) = last_prediction {
            out.top_motion = posterior(&p, &targets, Prior::Uniform, params)
                .top()
                .map(|t| t.0);
        }
    }
    out
}

/// Totals over many replays.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Report {
    pub traces: usize,
    /// Mean endpoint error (px) at 50/75/90 %.
    pub error_at: [f64; 3],
    pub correct_motion: f64,
    pub correct_prior: f64,
    /// Interventions on traces where the student clicked the expected target (want < 2 %).
    pub false_rate: f64,
    /// Interventions on traces where they clicked another one (higher is better).
    pub catch_rate: f64,
    /// Mean and worst pipeline time per frame (ms).
    pub frame_ms: f64,
    pub worst_frame_ms: f64,
}

pub fn report(traces: &[Trace], params: &TriggerParams) -> Report {
    let mut r = Report {
        traces: traces.len(),
        ..Report::default()
    };
    let mut errors = [(0.0, 0usize); 3];
    let (mut right, mut false_hits, mut wrong, mut caught) = (0usize, 0usize, 0usize, 0usize);
    let (mut motion_ok, mut prior_ok, mut prior_n) = (0usize, 0usize, 0usize);
    let (mut frames, mut total_ms) = (0u32, 0.0);
    for trace in traces {
        let replay = replay(trace, params);
        for (i, e) in replay.error_at.iter().enumerate() {
            if let Some(e) = e {
                errors[i].0 += e;
                errors[i].1 += 1;
            }
        }
        if replay.top_motion == Some(trace.clicked as u32) {
            motion_ok += 1;
        }
        if let Some(expected) = trace.expected {
            prior_n += 1;
            if replay.top_prior == Some(trace.clicked as u32) {
                prior_ok += 1;
            }
            if trace.clicked == expected {
                right += 1;
                false_hits += usize::from(replay.fired.is_some());
            } else {
                wrong += 1;
                caught += usize::from(replay.fired.is_some());
            }
        }
        frames += replay.frames;
        total_ms += replay.pipeline_ms;
        r.worst_frame_ms = r
            .worst_frame_ms
            .max(replay.pipeline_ms / f64::from(replay.frames.max(1)));
    }
    for (i, (sum, n)) in errors.iter().enumerate() {
        r.error_at[i] = if *n > 0 { sum / *n as f64 } else { f64::NAN };
    }
    r.correct_motion = motion_ok as f64 / traces.len().max(1) as f64;
    r.correct_prior = prior_ok as f64 / prior_n.max(1) as f64;
    r.false_rate = false_hits as f64 / right.max(1) as f64;
    r.catch_rate = caught as f64 / wrong.max(1) as f64;
    r.frame_ms = total_ms / f64::from(frames.max(1));
    r
}

/// A small deterministic random source (xorshift), so the synthetic set is the same every run.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }
    pub fn next_f64(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.next_f64()
    }
    /// Roughly normal (sum of uniforms).
    pub fn normal(&mut self, sd: f64) -> f64 {
        (0..6)
            .map(|_| self.next_f64())
            .sum::<f64>()
            .mul_add(sd, -3.0 * sd)
            * (2.0f64).sqrt()
    }
    pub fn pick(&mut self, n: usize) -> usize {
        ((self.next_f64() * n as f64) as usize).min(n - 1)
    }
}

/// Screen layouts the synthetic set aims into.
#[derive(Debug, Clone, Copy)]
pub enum Layout {
    /// A vertical menu: items 32 px tall, touching.
    Menu,
    /// A toolbar: 32 px buttons, 8 px apart.
    Toolbar,
    /// A settings page: a navigation list on the left, scattered controls on the right.
    Settings,
}

fn layout_targets(layout: Layout, rng: &mut Rng) -> Vec<[i32; 4]> {
    let (ox, oy) = (
        rng.range(-1600.0, 1200.0) as i32,
        rng.range(-200.0, 500.0) as i32,
    );
    match layout {
        Layout::Menu => (0..10)
            .map(|i| [ox, oy + 32 * i, ox + 240, oy + 32 * i + 32])
            .collect(),
        Layout::Toolbar => (0..14)
            .map(|i| [ox + 40 * i, oy, ox + 40 * i + 32, oy + 32])
            .collect(),
        Layout::Settings => {
            let mut t: Vec<[i32; 4]> = (0..8)
                .map(|i| [ox, oy + 44 * i, ox + 260, oy + 44 * i + 36])
                .collect();
            for i in 0..6 {
                let x = ox + 420 + (i % 2) * 300;
                let y = oy + 30 + (i / 2) * 120;
                t.push([x, y, x + 180, y + 36]);
            }
            t
        }
    }
}

/// One synthetic aimed movement from `from` to a point inside `goal`.
pub fn synth_movement(
    rng: &mut Rng,
    device: Device,
    from: (f64, f64),
    goal: [i32; 4],
) -> Vec<[f64; 3]> {
    let aim = (
        rng.range(f64::from(goal[0]) + 4.0, f64::from(goal[2]) - 4.0),
        rng.range(f64::from(goal[1]) + 4.0, f64::from(goal[3]) - 4.0),
    );
    let (dx, dy) = (aim.0 - from.0, aim.1 - from.1);
    let d = dx.hypot(dy).max(1.0);
    let w = f64::from((goal[2] - goal[0]).min(goal[3] - goal[1])).max(8.0);
    // Fitts' law: MT = a + b·log2(D/W + 1), with per-movement variation.
    let mt = (0.18 + 0.12 * (d / w + 1.0).log2()) * rng.range(0.85, 1.2);
    let primary_t = mt * rng.range(0.72, 0.85);
    let gain = rng.range(0.92, 1.04);
    let angle = rng.normal(0.025);
    let (c, s) = (angle.cos(), angle.sin());
    let first = (
        from.0 + gain * (dx * c - dy * s),
        from.1 + gain * (dx * s + dy * c),
    );
    let pause = rng.range(0.02, 0.06);
    let corr_t = (mt - primary_t).max(0.08);
    let pos = |tau: f64| {
        let t = tau.clamp(0.0, 1.0);
        t * t * t * (10.0 - 15.0 * t + 6.0 * t * t)
    };
    let (rate, jitter, tremor) = match device {
        Device::Mouse => (125.0, 0.6, 0.3),
        Device::Touchpad => (90.0, 2.5, 0.8),
        Device::Synthetic => (120.0, 0.0, 0.0),
    };
    let total = primary_t + pause + corr_t;
    let mut out = Vec::new();
    let mut t = 0.0;
    // A short rest before the movement starts.
    let rest = 0.08;
    while t < rest {
        out.push([
            t * 1000.0,
            from.0 + rng.normal(tremor),
            from.1 + rng.normal(tremor),
        ]);
        t += (1.0 / rate) * (1.0 + rng.normal(jitter / 10.0)).clamp(0.5, 1.5);
    }
    let mut local;
    loop {
        local = t - rest;
        if local > total {
            break;
        }
        let (x, y) = if local < primary_t {
            let k = pos(local / primary_t);
            (
                from.0 + (first.0 - from.0) * k,
                from.1 + (first.1 - from.1) * k,
            )
        } else if local < primary_t + pause {
            first
        } else {
            let k = pos((local - primary_t - pause) / corr_t);
            (
                first.0 + (aim.0 - first.0) * k,
                first.1 + (aim.1 - first.1) * k,
            )
        };
        out.push([t * 1000.0, x + rng.normal(tremor), y + rng.normal(tremor)]);
        t += (1.0 / rate) * (1.0 + rng.normal(jitter / 10.0)).clamp(0.5, 1.5);
    }
    out.push([t * 1000.0, aim.0, aim.1]);
    out
}

/// The synthetic set: `n` traces over the three layouts, half on a mouse and half on a touchpad.
/// With `wrong_share`, that share of traces click a target other than the expected one (a
/// neighbour half the time, anything else otherwise).
pub fn synthetic_set(n: usize, seed: u64, wrong_share: f64) -> Vec<Trace> {
    let mut rng = Rng::new(seed);
    (0..n)
        .map(|i| {
            let layout = [Layout::Menu, Layout::Toolbar, Layout::Settings][i % 3];
            let device = if i % 2 == 0 {
                Device::Mouse
            } else {
                Device::Touchpad
            };
            let targets = layout_targets(layout, &mut rng);
            let expected = rng.pick(targets.len());
            let clicked = if rng.next_f64() < wrong_share {
                if rng.next_f64() < 0.5 {
                    if expected + 1 < targets.len() {
                        expected + 1
                    } else {
                        expected - 1
                    }
                } else {
                    let mut c = rng.pick(targets.len());
                    if c == expected {
                        c = (c + 3) % targets.len();
                    }
                    c
                }
            } else {
                expected
            };
            let goal = targets[clicked];
            // Start 150–900 px away, in any direction.
            let angle = rng.range(0.0, std::f64::consts::TAU);
            let dist = rng.range(150.0, 900.0);
            let gx = f64::from(goal[0] + goal[2]) / 2.0;
            let gy = f64::from(goal[1] + goal[3]) / 2.0;
            let from = (gx + dist * angle.cos(), gy + dist * angle.sin());
            Trace {
                version: 1,
                device,
                samples: synth_movement(&mut rng, device, from, goal),
                targets: targets.clone(),
                clicked,
                expected: Some(expected),
            }
        })
        .collect()
}

/// Records traces from the live stream (the debug view's "record traces" switch): the raw
/// samples of the last movement before each click, the targets near it (rectangles only) and
/// the one clicked, which also counts as the expected one (the student clicked what they meant,
/// so these are the traces the false-intervention rate is measured on).
#[derive(Debug, Default)]
pub struct Recorder {
    samples: std::collections::VecDeque<[f64; 3]>,
}

/// Raw samples kept (about 3 s at 1 kHz).
const RECORD_MAX: usize = 3000;
/// A pause this long before the click starts the movement.
const RECORD_REST_MS: f64 = 200.0;

impl Recorder {
    pub fn push(&mut self, t_ms: f64, x: f64, y: f64) {
        if self.samples.len() >= RECORD_MAX {
            self.samples.pop_front();
        }
        self.samples.push_back([t_ms, x, y]);
    }

    /// A click at (x, y) with `targets` on screen: the trace, if the movement was long enough
    /// and a target was clicked.
    pub fn click(
        &mut self,
        t_ms: f64,
        x: f64,
        y: f64,
        targets: &[Target],
        device: Device,
    ) -> Option<Trace> {
        self.push(t_ms, x, y);
        let all: Vec<[f64; 3]> = self.samples.drain(..).collect();
        // Back from the click to the last point where the pointer was at rest.
        let mut start = 0;
        for i in (1..all.len()).rev() {
            let moved = (all[i][1] - all[i - 1][1]).hypot(all[i][2] - all[i - 1][2]);
            if all[i][0] - all[i - 1][0] >= RECORD_REST_MS && moved < 2.0 {
                start = i;
                break;
            }
        }
        let samples = all[start.saturating_sub(4)..].to_vec();
        let first = samples.first()?;
        if (first[1] - x).hypot(first[2] - y) < 60.0 || samples.len() < 8 {
            return None;
        }
        let near: Vec<&Target> = targets
            .iter()
            .filter(|t| super::posterior::distance_to(t.rect, (x, y)) < 800.0)
            .take(300)
            .collect();
        let clicked = near
            .iter()
            .position(|t| t.rect.contains(x as i32, y as i32))?;
        let t0 = first[0];
        Some(Trace {
            version: 1,
            device,
            samples: samples
                .iter()
                .map(|s| {
                    [
                        ((s[0] - t0) * 1000.0).round() / 1000.0,
                        s[1].round(),
                        s[2].round(),
                    ]
                })
                .collect(),
            targets: near
                .iter()
                .map(|t| [t.rect.left, t.rect.top, t.rect.right, t.rect.bottom])
                .collect(),
            clicked,
            expected: Some(clicked),
        })
    }
}

/// The traces recorded on this machine (`tests/traces/*.json` under the crate), if any.
pub fn recorded_traces(dir: &std::path::Path) -> Vec<Trace> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|text| Trace::parse(&text))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trace_round_trips_and_bad_ones_are_refused() {
        let trace = &synthetic_set(1, 7, 0.0)[0];
        let text = serde_json::to_string(trace).unwrap();
        let back = Trace::parse(&text).unwrap();
        // JSON floats may differ in the last bit; everything else is identical.
        assert_eq!(
            (back.clicked, back.expected, &back.targets),
            (trace.clicked, trace.expected, &trace.targets)
        );
        assert!(back
            .samples
            .iter()
            .zip(&trace.samples)
            .all(|(a, b)| (0..3).all(|i| (a[i] - b[i]).abs() < 1e-9)));
        let mut bad = trace.clone();
        bad.clicked = 999;
        assert!(Trace::parse(&serde_json::to_string(&bad).unwrap()).is_none());
        assert!(Trace::parse(r#"{"version":1}"#).is_none());
        let mut backwards = trace.clone();
        backwards.samples.swap(1, 2);
        backwards.samples[1][0] = 1e9;
        assert!(Trace::parse(&serde_json::to_string(&backwards).unwrap()).is_none());
    }

    #[test]
    fn the_recorder_keeps_one_movement_and_rectangles_only() {
        use crate::screen::cursor::target::t;
        let mut rec = Recorder::default();
        // Rest, then a movement to (500, 300).
        for i in 0..10 {
            rec.push(f64::from(i) * 8.0, 0.0, 0.0);
        }
        rec.push(400.0, 0.0, 0.0);
        for i in 1..=40 {
            let k = f64::from(i) / 40.0;
            rec.push(400.0 + f64::from(i) * 8.0, 500.0 * k, 300.0 * k);
        }
        let targets = vec![
            t(0, "Send", "Button", (480, 290, 540, 320)),
            t(1, "Far away", "Button", (3000, 3000, 3100, 3030)),
        ];
        let trace = rec
            .click(730.0, 500.0, 300.0, &targets, Device::Mouse)
            .unwrap();
        assert_eq!(trace.targets, vec![[480, 290, 540, 320]]);
        assert_eq!((trace.clicked, trace.expected), (0, Some(0)));
        assert!(trace.samples.len() < 50, "{}", trace.samples.len());
        let json = serde_json::to_string(&trace).unwrap();
        assert!(!json.contains("Send"));
        assert!(Trace::parse(&json).is_some());
        // A click with no movement, or on no target, records nothing.
        assert!(rec
            .click(740.0, 500.0, 300.0, &targets, Device::Mouse)
            .is_none());
    }

    #[test]
    fn synthetic_movements_end_on_their_target() {
        for trace in synthetic_set(60, 11, 0.3) {
            let (x, y) = trace.click_point();
            let r = trace.targets[trace.clicked];
            assert!(
                (r[0] as f64..=r[2] as f64).contains(&x)
                    && (r[1] as f64..=r[3] as f64).contains(&y),
                "{x},{y} not in {r:?}"
            );
        }
    }

    /// Threshold sweep for tuning (ignored: slow; run with --ignored --nocapture).
    #[test]
    #[ignore]
    fn threshold_sweep() {
        let right = synthetic_set(600, 2026, 0.0);
        let mixed = synthetic_set(600, 1120, 0.5);
        for stable in [1, 3, 5, 8] {
            for sigma_min in [10.0, 16.0, 24.0] {
                for p_wrong in [0.8, 0.9] {
                    let params = TriggerParams {
                        stable_frames: stable,
                        sigma_min,
                        p_wrong,
                        ..TriggerParams::default()
                    };
                    let f = report(&right, &params).false_rate;
                    let c = report(&mixed, &params).catch_rate;
                    println!("stable {stable} σmin {sigma_min} p {p_wrong}: false {:.2} % caught {:.1} %", f * 100.0, c * 100.0);
                }
            }
        }
    }

    /// The M2 report (run with --nocapture to see it). The false-intervention rate on
    /// right-target traces must stay under 2 %; the rest is reported, not asserted.
    #[test]
    fn replay_report() {
        let params = TriggerParams::default();
        // The full set in release builds (the numbers in docs/CURSOR_MODES.md); a smaller one in
        // debug builds, which are ~10× slower.
        let n = if cfg!(debug_assertions) { 150 } else { 600 };
        let right = synthetic_set(n, 2026, 0.0);
        let mixed = synthetic_set(n, 1120, 0.5);
        let all: Vec<Trace> = right.iter().chain(mixed.iter()).cloned().collect();
        let r = report(&all, &params);
        let right_only = report(&right, &params);
        println!("synthetic traces: {}", r.traces);
        println!(
            "endpoint error at 50/75/90 %: {:.0} / {:.0} / {:.0} px",
            r.error_at[0], r.error_at[1], r.error_at[2]
        );
        println!(
            "correct target at 90 %: motion only {:.1} %, with the intent prior {:.1} %",
            r.correct_motion * 100.0,
            r.correct_prior * 100.0
        );
        println!(
            "false interventions (right target clicked): {:.2} %  ·  wrong targets caught: {:.1} %",
            right_only.false_rate * 100.0,
            r.catch_rate * 100.0
        );
        println!(
            "pipeline per frame: mean {:.3} ms, worst trace mean {:.3} ms",
            r.frame_ms, r.worst_frame_ms
        );
        let recorded =
            recorded_traces(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/traces"));
        if !recorded.is_empty() {
            let rr = report(&recorded, &params);
            println!(
                "recorded traces: {} · error {:.0}/{:.0}/{:.0} px · false {:.2} %",
                rr.traces,
                rr.error_at[0],
                rr.error_at[1],
                rr.error_at[2],
                rr.false_rate * 100.0
            );
            assert!(
                rr.false_rate < 0.02,
                "recorded false rate {}",
                rr.false_rate
            );
        }
        assert!(
            right_only.false_rate < 0.02,
            "false interventions {:.2} %",
            right_only.false_rate * 100.0
        );
        assert!(r.frame_ms < 16.0);
    }
}
