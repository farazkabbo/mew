//! DO IT's replay (F): after every chore, about two seconds of Neb's ghost cursor travelling the
//! way it went while a caption spells out where things are ("Documents → Housing → 2026"), so
//! nothing is ever done silently and the student always knows where it is. "Show me how" then
//! turns the same request into a SHOW ME lesson.

use super::scene::{caption_at, Scene, Shape};
use crate::screen::frame::ScreenRect;

/// How long a replay lasts, and how long its last frame stays.
pub const REPLAY_MS: f64 = 2000.0;
pub const HOLD_MS: f64 = 1600.0;

#[derive(Debug, Clone, PartialEq)]
pub struct Replay {
    /// "Documents", "Housing", "2026": the places it went, in order.
    pub crumbs: Vec<String>,
    /// What was done, first in the caption ("Found lease.pdf in").
    pub verb: String,
    pub started_ms: f64,
    /// Where the ghost starts (the cursor when the chore finished).
    pub from: (f64, f64),
}

impl Replay {
    pub fn is_over(&self, now_ms: f64) -> bool {
        now_ms - self.started_ms > REPLAY_MS + HOLD_MS
    }

    /// The caption once every crumb is shown.
    pub fn caption(&self) -> String {
        let path = self.crumbs.join(" → ");
        if self.verb.is_empty() {
            path
        } else if path.is_empty() {
            self.verb.clone()
        } else {
            format!("{} {path}", self.verb)
        }
    }

    pub fn frame(&self, now_ms: f64, monitor: ScreenRect, scale: f32) -> Scene {
        let mut scene = Scene::default();
        if self.is_over(now_ms) {
            return scene;
        }
        let t = ((now_ms - self.started_ms) / REPLAY_MS).clamp(0.0, 1.0);
        let n = self.crumbs.len().max(1);
        // One crumb more every 1/n of the replay.
        let shown = ((t * n as f64).floor() as usize + 1).min(self.crumbs.len());
        let partial = Replay {
            crumbs: self.crumbs[..shown].to_vec(),
            ..self.clone()
        };
        // The ghost hops along a gentle arc to the right, one hop per crumb.
        let step = 70.0 * f64::from(scale);
        let x = self.from.0 + step * t * n as f64;
        let hop = (t * n as f64).fract();
        let y = self.from.1 - 18.0 * f64::from(scale) * (std::f64::consts::PI * hop).sin();
        let fade = if now_ms - self.started_ms > REPLAY_MS {
            (1.0 - (now_ms - self.started_ms - REPLAY_MS) / HOLD_MS).clamp(0.0, 1.0) as f32
        } else {
            1.0
        };
        scene.shapes.push(Shape::Dot {
            at: (x, y),
            radius: 7.0 * scale,
            alpha: 0.85 * fade,
        });
        let text = partial.caption();
        scene.shapes.push(Shape::Caption {
            at: caption_at(self.from, &text, scale, monitor, None),
            text,
            warn: false,
            scale,
        });
        scene
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crumbs_appear_one_by_one_then_it_ends() {
        let replay = Replay {
            crumbs: vec!["Documents".into(), "Housing".into(), "2026".into()],
            verb: "Found lease.pdf in".into(),
            started_ms: 1000.0,
            from: (500.0, 500.0),
        };
        let m = ScreenRect {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        let caption = |now: f64| {
            replay
                .frame(now, m, 1.0)
                .shapes
                .into_iter()
                .find_map(|s| match s {
                    Shape::Caption { text, .. } => Some(text),
                    _ => None,
                })
        };
        assert_eq!(
            caption(1000.0).as_deref(),
            Some("Found lease.pdf in Documents")
        );
        assert_eq!(
            caption(1700.0).as_deref(),
            Some("Found lease.pdf in Documents → Housing")
        );
        assert_eq!(
            caption(2900.0).as_deref(),
            Some("Found lease.pdf in Documents → Housing → 2026")
        );
        assert!(!replay.is_over(3000.0));
        assert!(replay.is_over(1000.0 + REPLAY_MS + HOLD_MS + 1.0));
        assert!(replay.frame(5000.0, m, 1.0).is_empty());
    }
}
