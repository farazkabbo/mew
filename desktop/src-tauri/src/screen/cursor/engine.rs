//! The per-frame pipeline every mode shares: raw mouse events in, a 120 Hz filtered sample, the
//! current movement and its predicted endpoint out. Pure, so the replay harness (`trace.rs`)
//! runs exactly what the app runs.

use super::euro::EuroParams;
use super::posterior::{posterior, Posterior, Prior, TriggerParams};
use super::predict::{EndpointModel, MinJerk, Phase, PredictParams, Prediction, Segmenter};
use super::scene::{caption_at, Scene, Shape};
use super::stream::{Kin, RawSample, Stream};
use super::target::TargetSet;
use crate::screen::frame::ScreenRect;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Input {
    Move {
        t_ms: f64,
        x: f64,
        y: f64,
    },
    Down {
        t_ms: f64,
        x: f64,
        y: f64,
    },
    Up {
        t_ms: f64,
        x: f64,
        y: f64,
    },
    Secondary {
        t_ms: f64,
    },
    /// The frame clock: no event came, time passed.
    Tick {
        t_ms: f64,
    },
}

/// What one frame's inputs did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Update {
    /// The newest filtered sample.
    pub kin: Option<Kin>,
    /// A movement began in this frame.
    pub started: bool,
    /// The movement ended in this frame (rest or a click).
    pub ended: bool,
    /// The current movement's prediction (only for movements worth predicting).
    pub prediction: Option<Prediction>,
    pub peak_speed: f64,
    /// Where the primary button went down in this frame (the student clicked).
    pub clicks: Vec<(f64, f64)>,
}

pub struct Engine {
    stream: Stream,
    segmenter: Segmenter,
    model: Box<dyn EndpointModel + Send>,
    samples: Vec<Kin>,
    peak: f64,
}

impl Engine {
    pub fn new(euro: EuroParams) -> Self {
        Self::with_model(euro, Box::new(MinJerk))
    }

    pub fn with_model(euro: EuroParams, model: Box<dyn EndpointModel + Send>) -> Self {
        Self {
            stream: Stream::new(euro),
            segmenter: Segmenter::new(PredictParams::default()),
            model,
            samples: Vec::with_capacity(8),
            peak: 0.0,
        }
    }

    pub fn feed(&mut self, inputs: &[Input]) -> Update {
        let mut update = Update::default();
        for input in inputs {
            self.samples.clear();
            match *input {
                Input::Move { t_ms, x, y } => self
                    .stream
                    .push(RawSample { t_ms, x, y }, &mut self.samples),
                Input::Down { t_ms, x, y } => {
                    self.stream
                        .push(RawSample { t_ms, x, y }, &mut self.samples);
                    update.clicks.push((x, y));
                }
                Input::Up { t_ms, x, y } => self
                    .stream
                    .push(RawSample { t_ms, x, y }, &mut self.samples),
                Input::Secondary { .. } => {}
                Input::Tick { t_ms } => self.stream.tick(t_ms, &mut self.samples),
            }
            for k in self.samples.drain(..) {
                match self.segmenter.push(k) {
                    Phase::Moving => {
                        if self
                            .segmenter
                            .movement()
                            .is_some_and(|m| m.samples.len() == 1)
                        {
                            update.started = true;
                            self.peak = 0.0;
                        }
                    }
                    Phase::Ended => update.ended = true,
                    Phase::Rest => {}
                }
                self.peak = self.peak.max(k.speed());
                update.kin = Some(k);
            }
            if matches!(input, Input::Down { .. } | Input::Secondary { .. })
                && self.segmenter.movement().is_some()
            {
                // The prediction made just before the click is what a mode acts on; the click
                // then ends the movement.
                update.prediction = self.predict();
                self.segmenter.end();
                update.ended = true;
            }
        }
        if update.prediction.is_none() {
            update.prediction = self.predict();
        }
        update.peak_speed = self.peak;
        update
    }

    fn predict(&self) -> Option<Prediction> {
        if !self.segmenter.substantial() {
            return None;
        }
        self.model.predict(self.segmenter.movement()?)
    }
}

/// The developer view (M1): the predicted endpoint, its σ, and the three likeliest targets.
pub fn debug_scene(
    update: &Update,
    set: &TargetSet,
    params: &TriggerParams,
    monitor: ScreenRect,
    scale: f32,
    frame_ms: f64,
) -> Scene {
    let mut scene = Scene::default();
    let Some(kin) = update.kin else {
        return scene;
    };
    let mut caption = format!("{} targets · {:.1} ms", set.targets.len(), frame_ms);
    if let Some(p) = update.prediction {
        let sigma = params.sigma(&p);
        scene.shapes.push(Shape::Ring {
            at: p.endpoint,
            radius: sigma as f32,
        });
        scene.shapes.push(Shape::Dot {
            at: p.endpoint,
            radius: 5.0 * scale,
            alpha: 0.9,
        });
        let post: Posterior = posterior(&p, &set.targets, Prior::Uniform, params);
        for (id, prob) in post.ranked.iter().take(3) {
            if let Some(t) = set.get(*id) {
                scene.shapes.push(Shape::Glow {
                    rect: t.rect,
                    scale: 1.0,
                    alpha: (*prob as f32).clamp(0.15, 1.0),
                    warn: false,
                });
            }
        }
        caption = format!(
            "{:.0}% · σ {:.0} · p {:.2} · {:.1} ms",
            p.progress * 100.0,
            sigma,
            post.top().map_or(0.0, |t| t.1),
            frame_ms
        );
    }
    scene.shapes.push(Shape::Caption {
        at: caption_at((kin.x, kin.y), &caption, scale, monitor, None),
        text: caption,
        warn: false,
        scale,
    });
    scene
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_click_ends_the_movement_with_a_prediction() {
        let mut engine = Engine::new(EuroParams::default());
        // A quick movement right, sampled at 125 Hz, then a click before it settles.
        let mut inputs = Vec::new();
        for i in 0..40 {
            let t = i as f64 * 8.0;
            let tau = (t / 320.0).min(1.0);
            let s = 10.0 * tau.powi(3) - 15.0 * tau.powi(4) + 6.0 * tau.powi(5);
            inputs.push(Input::Move {
                t_ms: t,
                x: 600.0 * s,
                y: 0.0,
            });
        }
        let first = engine.feed(&inputs[..30]);
        assert!(first.started);
        assert!(first.prediction.is_some());
        let clicked = engine.feed(&[Input::Down {
            t_ms: 240.0,
            x: 590.0,
            y: 0.0,
        }]);
        assert!(clicked.ended);
        assert_eq!(clicked.clicks, vec![(590.0, 0.0)]);
        assert!(clicked.prediction.is_some());
    }
}
