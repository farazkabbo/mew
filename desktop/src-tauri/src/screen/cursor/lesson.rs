//! A SHOW ME lesson (E): the student clicks, Neb guides. Pure: each frame it gets the engine's
//! update and the window's targets and answers with what to draw and what to do.
//!
//! - It never clicks, types or moves the cursor. It draws (the ghost path, the glow, a caption)
//!   and says short words.
//! - How much it shows fades with practice (`Level`): runs 1–2 the full ghost path, run 3 the
//!   next target only, run 4 on corrections only, and after two clean runs at that level nothing
//!   at all (the student can still ask to be shown).
//! - When the student is heading for the wrong control late in a movement, the right one grows
//!   and glows and Neb says one word ("below", "left", "not that one"), before the click.
//! - After each click it checks the step happened: the click landed on the expected control and
//!   the window reacted (a UI Automation event), or the next step's control appeared. A click on
//!   another control says what was opened, offers the way back, and asks for a re-plan from where
//!   the student is now.

use super::engine::Update;
use super::path::{resolve, Anchor};
use super::posterior::{cue, posterior, Cue, Prior, Trigger, TriggerParams};
use super::scene::{caption_at, centre, expand_scale, ghost_path, Scene, Shape};
use super::settings::Guidance;
use super::target::TargetSet;
use crate::screen::frame::ScreenRect;

/// How much a lesson shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// The ghost path from the cursor to the next control, its glow and its name.
    Full,
    /// The next control's glow and name only.
    NextOnly,
    /// Nothing unless the student heads for the wrong control.
    CorrectionsOnly,
    /// Nothing at all (the student has it; they can ask to be shown).
    Silent,
}

/// The level for a path practised `runs` times with `clean_streak` clean runs at the
/// corrections-only level (spec E: runs 1–2 full, 3 next-only, 4+ corrections, then silent).
pub fn level_for(runs: u32, clean_streak: u32, guidance: Guidance) -> Level {
    match guidance {
        Guidance::Full => Level::Full,
        Guidance::Light => Level::NextOnly,
        Guidance::CorrectionsOnly => Level::CorrectionsOnly,
        Guidance::Auto => match runs {
            0 | 1 => Level::Full,
            2 => Level::NextOnly,
            _ if clean_streak >= 2 => Level::Silent,
            _ => Level::CorrectionsOnly,
        },
    }
}

/// What a lesson asks the runtime to do.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// Say a sentence (through the page's voice).
    Say(String),
    /// Say a correction word (pre-generated, never waits on the network).
    Cue(Cue),
    /// Plan again from here (a free follow-up of the same question).
    Replan { happened: String },
    /// The lesson is over: every step done. `clean`: no correction or wrong click.
    Done { clean: bool },
    /// The lesson can't go on.
    GiveUp(String),
}

/// How long after a click its effect is checked, at the earliest and at the latest.
const VERIFY_MIN_MS: f64 = 250.0;
const VERIFY_MAX_MS: f64 = 1500.0;
/// A step whose control isn't on screen for this long is planned again.
const LOST_MS: f64 = 4000.0;
/// A correction's emphasis lasts this long.
const CORRECTION_MS: f64 = 1400.0;
/// Re-plans in one lesson (PLAN_LIMITS.replans).
pub const MAX_REPLANS: u32 = 4;

#[derive(Debug, Clone)]
struct Pending {
    at_ms: f64,
    generation: u64,
    /// The click landed on the expected control.
    on_expected: bool,
    /// The other control it landed on, if any.
    other: Option<String>,
    /// The expected control's automation id when it was hit (learned for next time).
    learned_id: String,
}

#[derive(Debug, Clone)]
pub struct Lesson {
    pub signature: String,
    pub goal: String,
    pub plan_id: Option<String>,
    pub steps: Vec<Anchor>,
    pub at: usize,
    pub level: Level,
    pub corrections: u32,
    pub wrong_clicks: u32,
    pub replans: u32,
    trigger: Trigger,
    pending: Option<Pending>,
    lost_since: Option<f64>,
    correcting: Option<(f64, Cue)>,
    awaiting_plan: bool,
    done: bool,
}

impl Lesson {
    pub fn new(
        signature: String,
        goal: String,
        plan_id: Option<String>,
        steps: Vec<Anchor>,
        level: Level,
    ) -> Self {
        Self {
            signature,
            goal,
            plan_id,
            steps,
            at: 0,
            level,
            corrections: 0,
            wrong_clicks: 0,
            replans: 0,
            trigger: Trigger::default(),
            pending: None,
            lost_since: None,
            correcting: None,
            awaiting_plan: false,
            done: false,
        }
    }

    pub fn is_over(&self) -> bool {
        self.done
    }

    /// The student asked to be shown: back to the full path for this lesson.
    pub fn show_everything(&mut self) {
        self.level = Level::Full;
    }

    /// A re-plan arrived: new steps from where the student is.
    pub fn replanned(&mut self, steps: Vec<Anchor>) {
        self.steps = steps;
        self.at = 0;
        self.pending = None;
        self.lost_since = None;
        self.awaiting_plan = false;
    }

    /// The re-plan failed: stop waiting for it.
    pub fn replan_failed(&mut self) {
        self.awaiting_plan = false;
        self.done = true;
    }

    fn replan(&mut self, happened: String, effects: &mut Vec<Effect>) {
        if self.awaiting_plan {
            return;
        }
        if self.replans >= MAX_REPLANS {
            self.done = true;
            effects.push(Effect::GiveUp(
                "I've lost the way from here. Ask me again and I'll start over.".into(),
            ));
            return;
        }
        self.replans += 1;
        self.awaiting_plan = true;
        effects.push(Effect::Replan { happened });
    }

    /// One frame. `generation` moves whenever the window's controls were collected again (after
    /// a UI Automation event), so a change after a click is seen.
    #[allow(clippy::too_many_arguments)]
    pub fn frame(
        &mut self,
        update: &Update,
        set: &TargetSet,
        generation: u64,
        now_ms: f64,
        params: &TriggerParams,
        monitor: ScreenRect,
        scale: f32,
    ) -> (Scene, Vec<Effect>) {
        let mut scene = Scene::default();
        let mut effects = Vec::new();
        if self.done || self.awaiting_plan || self.at >= self.steps.len() {
            return (scene, effects);
        }
        if update.started {
            self.trigger.reset();
        }
        let expected = resolve(&self.steps[self.at], set).cloned();

        // A click: note where it landed; it's checked a moment later.
        if let Some(&(x, y)) = update.clicks.last() {
            if self.pending.is_none() {
                let on_expected = expected
                    .as_ref()
                    .is_some_and(|t| t.rect.contains(x as i32, y as i32));
                let other = (!on_expected)
                    .then(|| {
                        set.targets
                            .iter()
                            .filter(|t| t.rect.contains(x as i32, y as i32))
                            .min_by_key(|t| i64::from(t.rect.width()) * i64::from(t.rect.height()))
                            .map(|t| t.name.trim().to_owned())
                    })
                    .flatten();
                self.pending = Some(Pending {
                    at_ms: now_ms,
                    generation,
                    on_expected,
                    other,
                    learned_id: expected
                        .as_ref()
                        .filter(|_| on_expected)
                        .map(|t| t.automation_id.clone())
                        .unwrap_or_default(),
                });
            }
        }

        if let Some(p) = self.pending.clone() {
            let waited = now_ms - p.at_ms;
            let reacted = generation != p.generation;
            if waited >= VERIFY_MIN_MS && (reacted || waited >= VERIFY_MAX_MS) {
                self.pending = None;
                if p.on_expected {
                    if !p.learned_id.is_empty() {
                        self.steps[self.at].automation_id = p.learned_id;
                    }
                    self.at += 1;
                    self.lost_since = None;
                    self.trigger.reset();
                    if self.at >= self.steps.len() {
                        self.done = true;
                        effects.push(Effect::Done {
                            clean: self.corrections == 0 && self.wrong_clicks == 0,
                        });
                    }
                    return (scene, effects);
                }
                if let Some(name) = p.other.filter(|_| reacted) {
                    self.wrong_clicks += 1;
                    let opened = if name.is_empty() {
                        "something else".into()
                    } else {
                        name
                    };
                    effects.push(Effect::Say(format!(
                        "That opened {opened}. Press Esc or Alt+Left to go back, or carry on from here."
                    )));
                    self.replan(format!("they clicked {opened} instead"), &mut effects);
                    return (scene, effects);
                }
                // A click on nothing that changed nothing: carry on with the same step.
            } else {
                return (scene, effects);
            }
        }

        let Some(target) = expected else {
            let since = *self.lost_since.get_or_insert(now_ms);
            if now_ms - since >= LOST_MS {
                let name = self.steps[self.at].name.clone();
                self.lost_since = None;
                self.replan(format!("{name} isn't on the screen"), &mut effects);
            }
            return (scene, effects);
        };
        self.lost_since = None;

        // Heading for the wrong control, late and slowing: the right one grows, one word.
        if let (Some(pred), Some(kin)) = (update.prediction, update.kin) {
            if self.level != Level::Silent && self.correcting.is_none() {
                let post = posterior(&pred, &set.targets, Prior::Expect(target.id), params);
                if let Some(wrong) = self.trigger.wrong_target(
                    &pred,
                    &kin,
                    update.peak_speed,
                    &post,
                    target.id,
                    params,
                ) {
                    if let Some(w) = set.get(wrong) {
                        let word = cue(w.rect, target.rect);
                        self.corrections += 1;
                        self.correcting = Some((now_ms, word));
                        effects.push(Effect::Cue(word));
                    }
                }
            }
        }
        let correcting = self
            .correcting
            .filter(|(at, _)| now_ms - at < CORRECTION_MS);
        if correcting.is_none() {
            self.correcting = None;
        }

        let cursor = update.kin.map(|k| (k.x, k.y));
        let late = update.prediction.map_or(1.0, |p| expand_scale(p.progress));
        let show_glow = matches!(self.level, Level::Full | Level::NextOnly) || correcting.is_some();
        if self.level == Level::Full && correcting.is_none() {
            if let Some(from) = cursor {
                let to = centre(target.rect);
                if (to.0 - from.0).hypot(to.1 - from.1) > 30.0 {
                    scene.shapes.push(ghost_path(from, to, 0.55));
                }
            }
        }
        if show_glow {
            scene.shapes.push(Shape::Glow {
                rect: target.rect,
                scale: if correcting.is_some() { 1.6 } else { late },
                alpha: if correcting.is_some() { 1.0 } else { 0.85 },
                warn: false,
            });
            if let Some(at) = cursor {
                let text = target.name.trim().to_owned();
                if !text.is_empty() {
                    scene.shapes.push(Shape::Caption {
                        at: caption_at(at, &text, scale, monitor, Some(target.rect)),
                        text,
                        warn: false,
                        scale,
                    });
                }
            }
        }
        (scene, effects)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::cursor::predict::Prediction;
    use crate::screen::cursor::stream::Kin;
    use crate::screen::cursor::target::t;

    fn anchor(name: &str) -> Anchor {
        Anchor {
            control_type: "ListItem".into(),
            name: name.into(),
            automation_id: String::new(),
            process: String::new(),
        }
    }

    fn page(names: &[&str]) -> TargetSet {
        TargetSet {
            process: "systemsettings.exe".into(),
            targets: names
                .iter()
                .enumerate()
                .map(|(i, n)| {
                    let y = 100 + 60 * i as i32;
                    let mut target = t(i as u32, n, "ListItem", (0, y, 300, y + 40));
                    target.automation_id = format!("id-{n}");
                    target
                })
                .collect(),
            ..TargetSet::default()
        }
    }

    fn at(x: f64, y: f64) -> Update {
        Update {
            kin: Some(Kin {
                x,
                y,
                ..Kin::default()
            }),
            ..Update::default()
        }
    }

    fn click(x: f64, y: f64) -> Update {
        Update {
            clicks: vec![(x, y)],
            ..at(x, y)
        }
    }

    const M: ScreenRect = ScreenRect {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
    };

    fn run(
        lesson: &mut Lesson,
        u: &Update,
        set: &TargetSet,
        generation: u64,
        now: f64,
    ) -> (Scene, Vec<Effect>) {
        lesson.frame(u, set, generation, now, &TriggerParams::default(), M, 1.0)
    }

    #[test]
    fn fading_follows_practice() {
        assert_eq!(level_for(0, 0, Guidance::Auto), Level::Full);
        assert_eq!(level_for(1, 0, Guidance::Auto), Level::Full);
        assert_eq!(level_for(2, 0, Guidance::Auto), Level::NextOnly);
        assert_eq!(level_for(3, 0, Guidance::Auto), Level::CorrectionsOnly);
        assert_eq!(level_for(5, 1, Guidance::Auto), Level::CorrectionsOnly);
        assert_eq!(level_for(5, 2, Guidance::Auto), Level::Silent);
        assert_eq!(level_for(9, 9, Guidance::Full), Level::Full);
        assert_eq!(
            level_for(0, 0, Guidance::CorrectionsOnly),
            Level::CorrectionsOnly
        );
    }

    #[test]
    fn a_full_lesson_draws_the_path_and_advances_on_the_right_click() {
        let set = page(&["System", "Personalization"]);
        let mut lesson = Lesson::new(
            "s".into(),
            "dark mode".into(),
            Some("p".into()),
            vec![anchor("Personalization"), anchor("Colors")],
            Level::Full,
        );
        let (scene, effects) = run(&mut lesson, &at(900.0, 600.0), &set, 1, 0.0);
        assert!(effects.is_empty());
        assert!(scene
            .shapes
            .iter()
            .any(|s| matches!(s, Shape::GhostPath { .. })));
        assert!(scene
            .shapes
            .iter()
            .any(|s| matches!(s, Shape::Caption { text, .. } if text == "Personalization")));
        // The student clicks Personalization; the window reacts (a new collection).
        run(&mut lesson, &click(150.0, 180.0), &set, 1, 100.0);
        let next = page(&["Colors", "Themes"]);
        let (_, effects) = run(&mut lesson, &at(150.0, 180.0), &next, 2, 400.0);
        assert!(effects.is_empty());
        assert_eq!(lesson.at, 1);
        // Its automation id was learned for next time.
        assert_eq!(lesson.steps[0].automation_id, "id-Personalization");
        // Colors, then done and clean.
        run(&mut lesson, &click(150.0, 120.0), &next, 2, 500.0);
        let (_, effects) = run(&mut lesson, &at(150.0, 120.0), &next, 3, 800.0);
        assert_eq!(effects, vec![Effect::Done { clean: true }]);
        assert!(lesson.is_over());
    }

    #[test]
    fn next_only_and_corrections_only_draw_less() {
        let set = page(&["Personalization"]);
        let mut next = Lesson::new(
            "s".into(),
            "g".into(),
            None,
            vec![anchor("Personalization")],
            Level::NextOnly,
        );
        let (scene, _) = run(&mut next, &at(900.0, 600.0), &set, 1, 0.0);
        assert!(!scene
            .shapes
            .iter()
            .any(|s| matches!(s, Shape::GhostPath { .. })));
        assert!(scene.shapes.iter().any(|s| matches!(s, Shape::Glow { .. })));
        let mut quiet = Lesson::new(
            "s".into(),
            "g".into(),
            None,
            vec![anchor("Personalization")],
            Level::CorrectionsOnly,
        );
        let (scene, _) = run(&mut quiet, &at(900.0, 600.0), &set, 1, 0.0);
        assert!(scene.is_empty());
    }

    #[test]
    fn heading_for_the_wrong_control_corrects_once_before_the_click() {
        // A toolbar-like row: Colors is expected, the student slows into Themes, two along.
        let mut set = page(&[]);
        for (i, n) in ["Colors", "Fonts", "Themes"].iter().enumerate() {
            let x = 100 + 120 * i as i32;
            set.targets
                .push(t(i as u32, n, "ListItem", (x, 100, x + 80, 140)));
        }
        let mut lesson = Lesson::new(
            "s".into(),
            "g".into(),
            None,
            vec![anchor("Colors")],
            Level::CorrectionsOnly,
        );
        let late = |now: f64| {
            Update {
                kin: Some(Kin {
                    x: 370.0,
                    y: 120.0,
                    vx: 80.0,
                    ax: -900.0,
                    ..Kin::default()
                }),
                prediction: Some(Prediction {
                    endpoint: (380.0, 120.0),
                    distance: 500.0,
                    progress: 0.95,
                    duration_ms: 500.0,
                }),
                peak_speed: 1600.0,
                ..Update::default()
            }
            .clone()
            .with_now(now)
        };
        let mut all = Vec::new();
        let mut drew = false;
        for i in 0..8 {
            let (scene, effects) = run(
                &mut lesson,
                &late(f64::from(i) * 8.3),
                &set,
                1,
                f64::from(i) * 8.3,
            );
            drew |= scene
                .shapes
                .iter()
                .any(|s| matches!(s, Shape::Glow { scale, .. } if *scale > 1.5));
            all.extend(effects);
        }
        assert_eq!(all, vec![Effect::Cue(Cue::Left)]);
        assert!(drew, "the right control grows");
        assert_eq!(lesson.corrections, 1);
    }

    #[test]
    fn a_wrong_click_says_what_opened_and_replans() {
        let set = page(&["System", "Personalization"]);
        let mut lesson = Lesson::new(
            "s".into(),
            "g".into(),
            Some("p".into()),
            vec![anchor("Personalization")],
            Level::Full,
        );
        run(&mut lesson, &click(150.0, 120.0), &set, 1, 0.0);
        let (_, effects) = run(
            &mut lesson,
            &at(150.0, 120.0),
            &page(&["Display"]),
            2,
            300.0,
        );
        assert!(matches!(&effects[0], Effect::Say(s) if s.starts_with("That opened System.")));
        assert_eq!(
            effects[1],
            Effect::Replan {
                happened: "they clicked System instead".into()
            }
        );
        // Nothing more until the new plan comes.
        let (scene, effects) = run(
            &mut lesson,
            &at(150.0, 120.0),
            &page(&["Display"]),
            3,
            400.0,
        );
        assert!(scene.is_empty() && effects.is_empty());
        lesson.replanned(vec![anchor("Display")]);
        let (scene, _) = run(
            &mut lesson,
            &at(900.0, 600.0),
            &page(&["Display"]),
            3,
            500.0,
        );
        assert!(!scene.is_empty());
    }

    #[test]
    fn a_missing_control_is_planned_again_then_given_up() {
        let mut lesson = Lesson::new(
            "s".into(),
            "g".into(),
            Some("p".into()),
            vec![anchor("Nowhere")],
            Level::Full,
        );
        let set = page(&["System"]);
        let mut replans = 0;
        let mut gave_up = false;
        for round in 0..6 {
            let start = f64::from(round) * 10_000.0;
            let (_, e) = run(&mut lesson, &at(0.0, 0.0), &set, 1, start);
            let (_, e2) = run(&mut lesson, &at(0.0, 0.0), &set, 1, start + LOST_MS + 1.0);
            for effect in e.into_iter().chain(e2) {
                match effect {
                    Effect::Replan { .. } => {
                        replans += 1;
                        lesson.replanned(vec![anchor("Nowhere")]);
                    }
                    Effect::GiveUp(_) => gave_up = true,
                    _ => {}
                }
            }
        }
        assert_eq!(replans, MAX_REPLANS);
        assert!(gave_up);
    }

    trait WithNow {
        fn with_now(self, now: f64) -> Self;
    }
    impl WithNow for Update {
        fn with_now(mut self, now: f64) -> Self {
            if let Some(k) = self.kin.as_mut() {
                k.t_ms = now;
            }
            self
        }
    }
}
