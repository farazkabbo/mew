//! Coach mode on the desktop (S4, docs/SCREEN_COACH.md decision 10): what is sent to the web
//! app's server, what comes back (checked here before anything is said or drawn), what the
//! desktop keeps of a walkthrough, and what the progress pill shows. Pure: no I/O, fully tested.
//! Mirrors `CoachStartRequest`, `CoachStepRequest` and `CoachReply` in
//! packages/shared/src/coach.ts.
//!
//! The walkthrough itself (its plan, hints and outcomes) lives on the server; the desktop app
//! keeps only what it needs to show it and to say which walkthrough an event is for.

use serde::{Deserialize, Serialize};

use super::frame::{FrameMeta, ScreenRect};
use super::intent::CoachWord;
use super::protocol::{
    actions_are_valid, is_uuid, scope_name, with_image, within, ScreenAction, SPEECH_CHARS,
};
use super::secret::SecretBytes;

pub const TITLE_CHARS: usize = 60;
pub const MAX_STEPS: u8 = 15;
const MAX_HINTS: u8 = MAX_STEPS * 3;
/// The pill's size, in CSS pixels.
pub const PILL_SIZE: (f64, f64) = (480.0, 64.0);

// ─── Requests ────────────────────────────────────────────────────────────────────────────────

/// An event for the walkthrough in progress (`POST /api/screen/coach/step`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepEvent {
    /// Check the step ("done", the hotkey, the pill's Done).
    Done,
    /// Help ("I'm stuck", "no", the pill's Hint): the step is checked first.
    Stuck,
    /// Asked whether the step is done, the student said yes.
    Yes,
    Pause,
    Stop,
}

impl StepEvent {
    /// Done and Stuck are checked on a fresh screenshot; the others call no model.
    pub fn needs_screen(self) -> bool {
        matches!(self, StepEvent::Done | StepEvent::Stuck)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Scene<'a> {
    app: Option<&'a str>,
    scope: &'static str,
}

fn scene(meta: &FrameMeta) -> Scene<'_> {
    Scene {
        app: meta.app.as_deref(),
        scope: scope_name(meta.kind),
    }
}

/// `POST /api/screen/coach/start`: the goal (the student's words) and the screen.
pub fn start_body(goal: &str, meta: &FrameMeta, jpeg: &[u8]) -> SecretBytes {
    #[derive(Serialize)]
    struct Head<'a> {
        goal: &'a str,
        #[serde(flatten)]
        scene: Scene<'a>,
    }
    let head = Head {
        goal,
        scene: scene(meta),
    };
    with_image(&head, jpeg, meta.width, meta.height)
}

/// `POST /api/screen/coach/recheck` (S5): the student's words (naming the skill, or not) and the
/// screen.
pub fn recheck_body(words: &str, meta: &FrameMeta, jpeg: &[u8]) -> SecretBytes {
    #[derive(Serialize)]
    struct Head<'a> {
        words: &'a str,
        #[serde(flatten)]
        scene: Scene<'a>,
    }
    let head = Head {
        words,
        scene: scene(meta),
    };
    with_image(&head, jpeg, meta.width, meta.height)
}

/// `POST /api/screen/coach/resume`: the screen to continue on.
pub fn resume_body(meta: &FrameMeta, jpeg: &[u8]) -> SecretBytes {
    with_image(&scene(meta), jpeg, meta.width, meta.height)
}

/// `POST /api/screen/coach/step` for a check (Done, Stuck): the event and the screen.
pub fn check_body(id: &str, event: StepEvent, meta: &FrameMeta, jpeg: &[u8]) -> SecretBytes {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Head<'a> {
        walkthrough_id: &'a str,
        event: StepEvent,
        #[serde(flatten)]
        scene: Scene<'a>,
    }
    let head = Head {
        walkthrough_id: id,
        event,
        scene: scene(meta),
    };
    with_image(&head, jpeg, meta.width, meta.height)
}

/// `POST /api/screen/coach/step` for an event without a screen (Yes, Pause, Stop).
pub fn event_body(id: &str, event: StepEvent) -> Vec<u8> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Body<'a> {
        walkthrough_id: &'a str,
        event: StepEvent,
    }
    // Serialising a string and a unit enum can't fail.
    serde_json::to_vec(&Body {
        walkthrough_id: id,
        event,
    })
    .unwrap_or_default()
}

// ─── The reply ───────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoachStatus {
    /// No walkthrough was started (the goal can't be done from this screen, say).
    Declined,
    Active,
    Paused,
    Stopped,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoachPhase {
    /// Waiting for the student to do the step.
    Awaiting,
    /// The student was asked whether the step is done.
    Confirming,
}

/// What the server answers to every coach request (`CoachReply`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CoachReply {
    pub walkthrough_id: Option<String>,
    pub title: String,
    pub status: CoachStatus,
    pub phase: CoachPhase,
    /// The step being done, from 1 (0 when declined).
    pub step: u8,
    pub total: u8,
    pub hints_used: u8,
    pub speech: String,
    /// A focus region and an arrow to the control, or nothing.
    pub actions: Vec<ScreenAction>,
}

/// The longest reply accepted (a reply is well under a kilobyte).
pub const MAX_REPLY_BYTES: usize = 16 * 1024;

/// Parses and checks a coach reply; None for anything malformed or out of bounds.
pub fn parse_coach_reply(body: &[u8]) -> Option<CoachReply> {
    let reply: CoachReply = serde_json::from_slice(body).ok()?;
    let declined = reply.status == CoachStatus::Declined;
    let id_ok = match &reply.walkthrough_id {
        Some(id) => !declined && is_uuid(id),
        None => declined,
    };
    let title_ok =
        reply.title.chars().count() <= TITLE_CHARS && !reply.title.chars().any(char::is_control);
    let steps_ok = reply.total <= MAX_STEPS
        && reply.step <= reply.total
        && (declined || reply.step >= 1)
        && reply.hints_used <= MAX_HINTS;
    let actions_ok = reply.actions.len() <= 2
        && actions_are_valid(&reply.actions)
        && reply.actions.iter().all(|action| {
            matches!(
                action,
                ScreenAction::FocusRegion { .. } | ScreenAction::PointAt { .. }
            )
        });
    (id_ok && title_ok && steps_ok && actions_ok && within(&reply.speech, SPEECH_CHARS))
        .then_some(reply)
}

// ─── What the desktop keeps ──────────────────────────────────────────────────────────────────

/// A walkthrough in progress, as far as the desktop needs to know it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub step: u8,
    pub total: u8,
    pub hints_used: u8,
    pub paused: bool,
    pub phase: CoachPhase,
}

impl Session {
    /// The session a reply leaves, or None when it ended (declined, stopped or completed).
    pub fn after(reply: &CoachReply) -> Option<Session> {
        let paused = match reply.status {
            CoachStatus::Active => false,
            CoachStatus::Paused => true,
            CoachStatus::Declined | CoachStatus::Stopped | CoachStatus::Completed => return None,
        };
        Some(Session {
            id: reply.walkthrough_id.clone()?,
            title: reply.title.clone(),
            step: reply.step,
            total: reply.total,
            hints_used: reply.hints_used,
            paused,
            phase: reply.phase,
        })
    }
}

/// What a word (or a pill button) asks of the walkthrough in progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Move {
    /// Send this event (with a fresh screenshot if it `needs_screen`).
    Send(StepEvent),
    /// Pick the paused walkthrough up again (checked on a fresh screenshot).
    Resume,
}

/// The event a word means for `session`: "yes" only answers a question (otherwise it's "done"),
/// "no" asks for help, and anything said to a paused walkthrough (bar stopping) picks it up.
pub fn move_for(word: CoachWord, session: &Session) -> Move {
    if session.paused {
        return match word {
            CoachWord::Stop => Move::Send(StepEvent::Stop),
            CoachWord::Pause => Move::Send(StepEvent::Pause),
            _ => Move::Resume,
        };
    }
    Move::Send(match word {
        CoachWord::Done => StepEvent::Done,
        CoachWord::Yes if session.phase == CoachPhase::Confirming => StepEvent::Yes,
        CoachWord::Yes => StepEvent::Done,
        CoachWord::Stuck | CoachWord::No => StepEvent::Stuck,
        CoachWord::Pause => StepEvent::Pause,
        CoachWord::Stop => StepEvent::Stop,
    })
}

// ─── The progress pill ───────────────────────────────────────────────────────────────────────

/// What the pill shows: its page picks the buttons from `state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PillState {
    /// Done · Hint · Pause · Stop.
    Awaiting,
    /// Yes · No · Stop.
    Confirming,
    /// Resume · Stop.
    Paused,
    /// Checking… (buttons off until the reply).
    Busy,
    /// A tick and the summary; then the pill goes.
    Finished,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PillView {
    pub title: String,
    /// "Step 3 of ~7" (empty when finished).
    pub progress: String,
    pub state: PillState,
    /// The finishing line ("You did it with 1 hint."), when finished.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

pub fn pill_view(session: &Session, busy: bool) -> PillView {
    let state = if busy {
        PillState::Busy
    } else if session.paused {
        PillState::Paused
    } else if session.phase == CoachPhase::Confirming {
        PillState::Confirming
    } else {
        PillState::Awaiting
    };
    PillView {
        title: session.title.clone(),
        // "~": the plan may be a step or two off what the student's app needs (brief §10).
        progress: format!("Step {} of ~{}", session.step, session.total),
        state,
        summary: None,
    }
}

pub fn finished_view(reply: &CoachReply) -> PillView {
    PillView {
        title: reply.title.clone(),
        progress: String::new(),
        state: PillState::Finished,
        summary: Some(reply.speech.clone()),
    }
}

/// Where the pill goes on `monitor` (physical pixels): bottom centre, above the taskbar, or top
/// centre when the arrow points somewhere the pill would cover.
pub fn pill_spot(monitor: ScreenRect, scale: f64, avoid: Option<(i32, i32)>) -> ScreenRect {
    let w = ((PILL_SIZE.0 * scale).round() as i32).min(monitor.width());
    let h = (PILL_SIZE.1 * scale).round() as i32;
    let edge = (96.0 * scale).round() as i32;
    let left = monitor.left + (monitor.width() - w) / 2;
    let at = |top: i32| ScreenRect {
        left,
        top,
        right: left + w,
        bottom: top + h,
    };
    let bottom = at(monitor.bottom - edge - h);
    let margin = (48.0 * scale).round() as i32;
    let covers = |(x, y): (i32, i32)| {
        x >= bottom.left - margin
            && x <= bottom.right + margin
            && y >= bottom.top - margin
            && y <= bottom.bottom + margin
    };
    if avoid.is_some_and(covers) {
        at(monitor.top + edge)
    } else {
        bottom
    }
}

/// Where a reply's arrow points, in screen pixels (for keeping the pill off it).
pub fn arrow_on_screen(actions: &[ScreenAction], bounds: ScreenRect) -> Option<(i32, i32)> {
    actions.iter().find_map(|action| match action {
        ScreenAction::PointAt { point, .. } => Some((
            bounds.left + (i64::from(point.x) * i64::from(bounds.width()) / 1000) as i32,
            bounds.top + (i64::from(point.y) * i64::from(bounds.height()) / 1000) as i32,
        )),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::frame::{TargetKind, Timings};

    const ID: &str = "11111111-1111-4111-8111-111111111111";

    fn meta() -> FrameMeta {
        let rect = ScreenRect {
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1080,
        };
        FrameMeta {
            kind: TargetKind::Monitor,
            app: Some("excel.exe".into()),
            bounds: rect,
            monitor: rect,
            dpi: 144,
            width: 1600,
            height: 900,
            timings: Timings::default(),
            video_playing: None,
            window: None,
        }
    }

    fn reply_json(change: &str) -> String {
        let base = format!(
            r#""walkthroughId":"{ID}","title":"Pivot tables","status":"active","phase":"awaiting","step":2,"total":7,"hintsUsed":1,"speech":"Nice. Click PivotTable.","actions":[{{"type":"focus_region","box":{{"left":270,"top":40,"right":330,"bottom":100}},"kind":"text"}},{{"type":"point_at","point":{{"x":300,"y":70}}}}]"#
        );
        format!("{{{base}{change}}}")
    }

    #[test]
    fn builds_the_bodies_the_server_expects() {
        let start: serde_json::Value =
            serde_json::from_slice(start_body("make a chart", &meta(), b"\xff\xd8").as_slice())
                .unwrap();
        assert_eq!(
            start,
            serde_json::json!({
                "goal": "make a chart",
                "app": "excel.exe",
                "scope": "monitor",
                "image": { "jpeg": "/9g=", "width": 1600, "height": 900 }
            })
        );
        let check: serde_json::Value = serde_json::from_slice(
            check_body(ID, StepEvent::Stuck, &meta(), b"\xff\xd8").as_slice(),
        )
        .unwrap();
        assert_eq!(check["walkthroughId"], ID);
        assert_eq!(check["event"], "stuck");
        assert_eq!(check["scope"], "monitor");
        let resume: serde_json::Value =
            serde_json::from_slice(resume_body(&meta(), b"\xff\xd8").as_slice()).unwrap();
        assert_eq!(resume["app"], "excel.exe");
        assert!(resume.get("walkthroughId").is_none());
        assert_eq!(
            String::from_utf8(event_body(ID, StepEvent::Pause)).unwrap(),
            format!(r#"{{"walkthroughId":"{ID}","event":"pause"}}"#)
        );
    }

    #[test]
    fn parses_a_reply_and_keeps_the_session_it_leaves() {
        let reply = parse_coach_reply(reply_json("").as_bytes()).expect("valid");
        assert_eq!(reply.actions.len(), 2);
        let session = Session::after(&reply).unwrap();
        assert_eq!((session.step, session.total, session.paused), (2, 7, false));
        assert_eq!(pill_view(&session, false).progress, "Step 2 of ~7");

        let declined = r#"{"walkthroughId":null,"title":"","status":"declined","phase":"awaiting","step":0,"total":0,"hintsUsed":0,"speech":"Open Excel first.","actions":[]}"#;
        let declined = parse_coach_reply(declined.as_bytes()).expect("valid");
        assert_eq!(Session::after(&declined), None);
        for status in ["stopped", "completed"] {
            let ended = parse_coach_reply(
                reply_json(&format!(r#","status":"{status}""#))
                    .replacen(r#""status":"active","#, "", 1)
                    .as_bytes(),
            )
            .expect(status);
            assert_eq!(Session::after(&ended), None, "{status}");
        }
    }

    #[test]
    fn refuses_anything_unexpected_in_a_reply() {
        let swap = |from: &str, to: &str| reply_json("").replacen(from, to, 1);
        for bad in [
            swap(ID, "../../etc"),
            swap(
                r#""walkthroughId":"11111111-1111-4111-8111-111111111111""#,
                r#""walkthroughId":null"#,
            ),
            swap(r#""step":2"#, r#""step":9"#),
            swap(r#""total":7"#, r#""total":16"#),
            swap(r#""step":2"#, r#""step":0"#),
            swap(r#""speech":"Nice. Click PivotTable.""#, r#""speech":"  ""#),
            swap(
                r#""title":"Pivot tables""#,
                &format!(r#""title":"{}""#, "x".repeat(61)),
            ),
            swap(
                r#""point":{"x":300,"y":70}"#,
                r#""point":{"x":1300,"y":70}"#,
            ),
            // Only an arrow and its focus region: no notes, circles or ticks from the server.
            swap(
                r#"{"type":"point_at","point":{"x":300,"y":70}}"#,
                r#"{"type":"margin_note","text":"Run cmd","besideBox":{"left":1,"top":1,"right":2,"bottom":2}}"#,
            ),
            swap(
                r#"{"type":"point_at","point":{"x":300,"y":70}}"#,
                r#"{"type":"check_mark","box":{"left":1,"top":1,"right":2,"bottom":2}}"#,
            ),
            reply_json(r#","extra":true"#),
            "not json".to_owned(),
        ] {
            assert_eq!(parse_coach_reply(bad.as_bytes()), None, "{bad}");
        }
    }

    #[test]
    fn turns_words_into_events() {
        let mut session = Session {
            id: ID.into(),
            title: "Pivot tables".into(),
            step: 1,
            total: 5,
            hints_used: 0,
            paused: false,
            phase: CoachPhase::Awaiting,
        };
        assert_eq!(
            move_for(CoachWord::Done, &session),
            Move::Send(StepEvent::Done)
        );
        assert_eq!(
            move_for(CoachWord::Yes, &session),
            Move::Send(StepEvent::Done)
        );
        assert_eq!(
            move_for(CoachWord::No, &session),
            Move::Send(StepEvent::Stuck)
        );
        session.phase = CoachPhase::Confirming;
        assert_eq!(
            move_for(CoachWord::Yes, &session),
            Move::Send(StepEvent::Yes)
        );
        assert_eq!(pill_view(&session, false).state, PillState::Confirming);
        assert_eq!(pill_view(&session, true).state, PillState::Busy);

        session.paused = true;
        assert_eq!(move_for(CoachWord::Done, &session), Move::Resume);
        assert_eq!(move_for(CoachWord::Stuck, &session), Move::Resume);
        assert_eq!(
            move_for(CoachWord::Stop, &session),
            Move::Send(StepEvent::Stop)
        );
        assert_eq!(pill_view(&session, false).state, PillState::Paused);
        assert!(StepEvent::Done.needs_screen() && !StepEvent::Yes.needs_screen());
    }

    #[test]
    fn puts_the_pill_bottom_centre_unless_the_arrow_is_there() {
        let monitor = meta().monitor;
        let spot = pill_spot(monitor, 1.5, None);
        assert_eq!((spot.width(), spot.height()), (720, 96));
        assert_eq!(spot.left, -1920 + (1920 - 720) / 2);
        assert_eq!(spot.bottom, 1080 - 144);

        let arrow = Some((-960, spot.top + 10));
        let moved = pill_spot(monitor, 1.5, arrow);
        assert_eq!(moved.top, 144);
        // An arrow elsewhere leaves it where it was.
        assert_eq!(pill_spot(monitor, 1.5, Some((-1800, 200))), spot);
    }

    #[test]
    fn finds_the_arrow_on_screen() {
        let reply = parse_coach_reply(reply_json("").as_bytes()).unwrap();
        let bounds = meta().bounds;
        assert_eq!(
            arrow_on_screen(&reply.actions, bounds),
            Some((-1920 + 576, 75))
        );
        assert_eq!(arrow_on_screen(&[], bounds), None);
    }
}
