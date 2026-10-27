//! Coach mode (S4, docs/SCREEN_COACH.md §2.2, §5 and decision 10): a guided walkthrough of a task
//! on the student's screen, one step at a time.
//!
//! The walkthrough lives on the web app's server, which plans it, checks each step and decides
//! what happens next. This module is the desktop's half:
//! 1. "Teach me how to…" over the hotkey starts one (`start`), with the capture already taken.
//! 2. Every event goes to the server: words over the hotkey (`on_word`), and the progress pill's
//!    buttons (`screen_coach_pill`). "Done" and "Hint" need a fresh capture of the monitor under
//!    the cursor (decision 6), taken by `coach::capture_for_coach`, which hands it to
//!    `on_captured`.
//! 3. Each reply (`apply`) is said by the page, its arrow drawn by the ink overlay, and its state
//!    shown in the pill. Ink drawn here never takes Esc (Excel and Word need it) and never shows
//!    the ink pill.
//!
//! Only one request runs at a time (`busy`): a second "done" while one is checked is ignored.
//! Pausing Screen Coach ends the walkthrough here at once (`end_quietly`); a reply still on its
//! way then belongs to an older `generation` and is dropped.

use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use super::account::{forget_revoked_token, wipe_string};
use super::annotate::{self, ShowInk};
use super::coach::{self, ScreenCoach};
use super::frame::{FrameDetail, FrameMeta, ScreenRect};
use super::intent::CoachWord;
use super::overlay::{self, require_surface, Surface};
use super::page;
use super::pipeline::Captured;
use super::walkthrough::{
    self, arrow_on_screen, check_body, event_body, finished_view, move_for, parse_coach_reply,
    pill_spot, pill_view, recheck_body, resume_body, start_body, CoachReply, CoachStatus, Move,
    PillView, Session, StepEvent,
};
use super::win::{credential, http};

/// Pill page events (desktop/overlay-src/coach-pill.ts).
const PILL_SHOW: &str = "mew:coach-pill-show";
/// How long the finished pill (a tick and the summary) stays.
const FINISHED_FOR: Duration = Duration::from_secs(8);

/// What the desktop knows of coach mode right now.
#[derive(Default)]
pub struct CoachState {
    session: Option<Session>,
    /// A request is on its way to the server.
    busy: bool,
    /// Bumped when the walkthrough is ended here: replies to earlier requests are dropped.
    generation: u64,
    /// The monitor the pill is on, and its DPI (events without a capture keep it there).
    monitor: Option<(ScreenRect, u32)>,
}

/// What a coach-mode capture is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoachCapture {
    /// Check the step (Done) or help (Stuck): a step event with the screen.
    Check(StepEvent),
    /// Pick up a paused walkthrough on this screen.
    Resume,
}

fn state<R: Runtime>(app: &AppHandle<R>) -> Option<std::sync::MutexGuard<'_, CoachState>> {
    app.try_state::<ScreenCoach>()
        .map(|coach| coach.inner().coaching())
}

/// A walkthrough is in progress (active or paused): the hotkey captures the monitor, and the
/// words over it are checked for coach words first.
pub fn is_coaching<R: Runtime>(app: &AppHandle<R>) -> bool {
    state(app).is_some_and(|s| s.session.is_some())
}

/// The walkthrough a question is asked in, while one is going on (the tutor answers in its
/// context).
pub fn active_walkthrough<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let state = state(app)?;
    let session = state.session.as_ref()?;
    (!session.paused).then(|| session.id.clone())
}

// ─── Starting, steering, resuming ────────────────────────────────────────────────────────────

/// "Teach me how to…": plans a walkthrough of `goal` on the captured screen.
pub fn start<R: Runtime>(app: &AppHandle<R>, goal: String, captured: Captured) {
    let Some(generation) = claim(app) else {
        return;
    };
    show_notice_once(app);
    let handle = app.clone();
    in_background(app, move || {
        let Captured { jpeg, meta, detail } = captured;
        let body = start_body(&goal, &meta, jpeg.as_slice());
        drop(jpeg); // only the request body holds the image now
        let reply = send(&handle, "api/screen/coach/start", body.as_slice());
        drop(body);
        finish(&handle, generation, reply, Some((meta, detail)));
    });
}

/// A word over the hotkey during a walkthrough, with the capture taken when the key went down.
pub fn on_word<R: Runtime>(app: &AppHandle<R>, word: CoachWord, captured: Captured) {
    let Some(session) = state(app).and_then(|s| s.session.clone()) else {
        return;
    };
    match move_for(word, &session) {
        Move::Resume => resume(app, captured),
        Move::Send(event) if event.needs_screen() => check(app, &session.id, event, captured),
        Move::Send(event) => {
            drop(captured); // not needed: wiped unsent
            send_event(app, event);
        }
    }
}

/// S5: "let me try pivot tables on my own": a solo re-check of a skill learned before. Its
/// reply is a walkthrough like any other (one step, no arrow), checked the same way.
pub fn recheck<R: Runtime>(app: &AppHandle<R>, words: String, captured: Captured) {
    let Some(generation) = claim(app) else {
        return;
    };
    show_notice_once(app);
    let handle = app.clone();
    in_background(app, move || {
        let Captured { jpeg, meta, detail } = captured;
        let body = recheck_body(&words, &meta, jpeg.as_slice());
        drop(jpeg);
        let reply = send(&handle, "api/screen/coach/recheck", body.as_slice());
        drop(body);
        finish(&handle, generation, reply, Some((meta, detail)));
    });
}

/// "Continue where we left off" (or a word to a paused walkthrough): the latest unfinished
/// walkthrough, checked on this screen.
pub fn resume<R: Runtime>(app: &AppHandle<R>, captured: Captured) {
    let Some(generation) = claim(app) else {
        return;
    };
    let handle = app.clone();
    in_background(app, move || {
        let Captured { jpeg, meta, detail } = captured;
        let body = resume_body(&meta, jpeg.as_slice());
        drop(jpeg);
        let reply = send(&handle, "api/screen/coach/resume", body.as_slice());
        drop(body);
        finish(&handle, generation, reply, Some((meta, detail)));
    });
}

/// A capture taken for the pill's Done, Hint, No or Resume.
pub fn on_captured<R: Runtime>(app: &AppHandle<R>, kind: CoachCapture, captured: Captured) {
    match kind {
        CoachCapture::Resume => resume(app, captured),
        CoachCapture::Check(event) => {
            let Some(id) = state(app).and_then(|s| s.session.as_ref().map(|s| s.id.clone())) else {
                return;
            };
            check(app, &id, event, captured);
        }
    }
}

/// The capture for a pill button was refused (a blocked app in front, say) or failed: the pill
/// becomes usable again (the reason was already shown).
pub fn capture_failed<R: Runtime>(app: &AppHandle<R>) {
    refresh_pill(app, None);
}

fn check<R: Runtime>(app: &AppHandle<R>, id: &str, event: StepEvent, captured: Captured) {
    let Some(generation) = claim(app) else {
        return;
    };
    let handle = app.clone();
    let id = id.to_owned();
    in_background(app, move || {
        let Captured { jpeg, meta, detail } = captured;
        let body = check_body(&id, event, &meta, jpeg.as_slice());
        drop(jpeg);
        let reply = send(&handle, "api/screen/coach/step", body.as_slice());
        drop(body);
        finish(&handle, generation, reply, Some((meta, detail)));
    });
}

/// An event that needs no screen (Yes, Pause, Stop).
fn send_event<R: Runtime>(app: &AppHandle<R>, event: StepEvent) {
    let Some(id) = state(app).and_then(|s| s.session.as_ref().map(|s| s.id.clone())) else {
        return;
    };
    let Some(generation) = claim(app) else {
        return;
    };
    let handle = app.clone();
    in_background(app, move || {
        let reply = send(&handle, "api/screen/coach/step", &event_body(&id, event));
        finish(&handle, generation, reply, None);
    });
}

/// Stops the walkthrough without a word (Screen Coach was paused or turned off): the server is
/// told in the background (so it can be resumed later), and the pill goes at once.
pub fn end_quietly<R: Runtime>(app: &AppHandle<R>) {
    let Some(id) = state(app).and_then(|mut s| {
        s.busy = false;
        s.generation += 1;
        s.session.take().map(|session| session.id)
    }) else {
        return;
    };
    overlay::hide_quietly_named(app, Surface::Coach);
    let handle = app.clone();
    in_background(app, move || {
        let _ = send(
            &handle,
            "api/screen/coach/step",
            &event_body(&id, StepEvent::Stop),
        );
    });
}

/// "Stop the walkthrough" from the tray.
pub fn stop_from_tray<R: Runtime>(app: &AppHandle<R>) {
    send_event(app, StepEvent::Stop);
}

// ─── Talking to the server ───────────────────────────────────────────────────────────────────

/// Marks a request as on its way and returns its generation; None (and a word to the student)
/// if one already is.
fn claim<R: Runtime>(app: &AppHandle<R>) -> Option<u64> {
    let claimed = state(app).and_then(|mut s| {
        let free = !std::mem::replace(&mut s.busy, true);
        free.then_some(s.generation)
    });
    if claimed.is_some() {
        refresh_pill(app, None);
    } else {
        say(app, "One moment, I'm still on it.");
    }
    claimed
}

fn in_background<R: Runtime>(app: &AppHandle<R>, work: impl FnOnce() + Send + 'static) {
    let spawned = std::thread::Builder::new()
        .name("mew-coach".into())
        .spawn(work);
    if spawned.is_err() {
        if let Some(mut s) = state(app) {
            s.busy = false;
        }
        coach::notify(app, "Coach mode couldn't start that just now.");
    }
}

/// POSTs `body` to `path` with the device token and checks the reply.
fn send<R: Runtime>(app: &AppHandle<R>, path: &str, body: &[u8]) -> Result<CoachReply, String> {
    let coach = app
        .try_state::<ScreenCoach>()
        .ok_or("Screen Coach isn't ready.")?;
    let token = credential::load().ok_or(
        "Connect Screen Coach to your Neb account first: tray → Screen Coach settings → Connect.",
    )?;
    let token = std::str::from_utf8(token.as_slice())
        .map_err(|_| "Connect Screen Coach again in its settings.")?;
    let url = coach
        .app_url()
        .join(path)
        .map_err(|_| "The Neb address is invalid.")?;
    let mut headers = [
        "Content-Type: application/json".to_owned(),
        "Accept: application/json".to_owned(),
        format!("Authorization: Bearer {token}"),
    ];

    let started = Instant::now();
    let mut reply = Vec::new();
    let mut too_large = false;
    let result = http::post(&url, &headers, body, |chunk| {
        if reply.len() + chunk.len() > walkthrough::MAX_REPLY_BYTES {
            too_large = true;
        } else {
            reply.extend_from_slice(chunk);
        }
    });
    headers.iter_mut().for_each(|header| wipe_string(header));
    let status =
        result.map_err(|_| "I couldn't reach Neb. Check your connection and try again.")?;
    // Timings and statuses only: never what was said or on screen.
    eprintln!(
        "[screen] coach {path}: status {status} in {} ms",
        started.elapsed().as_millis()
    );
    match status {
        200 if !too_large => {}
        401 => {
            forget_revoked_token(app);
            return Err("Screen Coach was signed out of your Neb account. Connect again in Screen Coach settings.".into());
        }
        404 | 409 => return Err(String::new()), // that walkthrough ended or moved on elsewhere
        429 => {
            return Err(
                "You've done a lot of coaching for now. Try again in a little while.".into(),
            )
        }
        503 => return Err("Coach mode isn't available right now.".into()),
        _ => return Err("Coach mode couldn't answer just now. Try again in a moment.".into()),
    }
    parse_coach_reply(&reply).ok_or_else(|| "Coach mode couldn't answer just now.".to_owned())
}

/// Ends a request: applies the reply, or says what went wrong. A reply for a walkthrough that
/// was ended here meanwhile (Screen Coach was paused) is dropped, screen and all.
fn finish<R: Runtime>(
    app: &AppHandle<R>,
    generation: u64,
    reply: Result<CoachReply, String>,
    scene: Option<(FrameMeta, FrameDetail)>,
) {
    let current = state(app).is_some_and(|mut s| {
        let current = s.generation == generation;
        if current {
            s.busy = false;
        }
        current
    });
    if !current {
        return;
    }
    match reply {
        Ok(reply) => apply(app, reply, scene),
        Err(message) => {
            if message.is_empty() {
                // The walkthrough was finished or moved on from another event: forget ours.
                end_locally(app);
            } else {
                coach::notify(app, &message);
                refresh_pill(app, None);
            }
        }
    }
    coach::settle(app);
}

// ─── Showing a reply ─────────────────────────────────────────────────────────────────────────

/// Says the reply, draws its arrow (on the screen it was checked on) and updates the pill.
fn apply<R: Runtime>(
    app: &AppHandle<R>,
    reply: CoachReply,
    scene: Option<(FrameMeta, FrameDetail)>,
) {
    say(app, &reply.speech);
    if reply.status == CoachStatus::Declined {
        // Nothing was started (or there was nothing to continue): whatever was going on stays.
        refresh_pill(app, None);
        return;
    }
    let session = Session::after(&reply);
    let monitor = {
        let Some(mut s) = state(app) else {
            return;
        };
        s.session = session.clone();
        if let Some((meta, _)) = &scene {
            s.monitor = Some((meta.monitor, meta.dpi));
        }
        s.monitor
    };

    let arrow = scene
        .as_ref()
        .and_then(|(meta, _)| arrow_on_screen(&reply.actions, meta.bounds));
    match (&session, scene) {
        (Some(session), Some((meta, detail))) if !session.paused && !reply.actions.is_empty() => {
            annotate::show(
                app,
                ShowInk {
                    seed: session.id.clone(),
                    actions: reply.actions.clone(),
                    meta,
                    detail,
                    video_time_sec: None,
                    clip_when_drawn: false,
                    coaching: true,
                },
            );
        }
        // No arrow for this reply: the old one is about another step (or nothing).
        _ => annotate::clear(app),
    }

    match (&session, reply.status) {
        (Some(_), _) => refresh_pill(app, arrow),
        (None, CoachStatus::Completed) => show_finished(app, &reply, monitor),
        (None, _) => overlay::hide_quietly_named(app, Surface::Coach),
    }
    coach::refresh(app);
}

/// The pill as the session stands (hidden when there's none), kept off `arrow` if given.
fn refresh_pill<R: Runtime>(app: &AppHandle<R>, arrow: Option<(i32, i32)>) {
    let Some((view, monitor)) = state(app).and_then(|s| {
        let session = s.session.as_ref()?;
        Some((pill_view(session, s.busy), s.monitor))
    }) else {
        overlay::hide_quietly_named(app, Surface::Coach);
        return;
    };
    show_pill(app, &view, monitor, arrow);
}

fn show_finished<R: Runtime>(
    app: &AppHandle<R>,
    reply: &CoachReply,
    monitor: Option<(ScreenRect, u32)>,
) {
    show_pill(app, &finished_view(reply), monitor, None);
    let handle = app.clone();
    let _ = std::thread::Builder::new()
        .name("mew-coach-finished".into())
        .spawn(move || {
            std::thread::sleep(FINISHED_FOR);
            // A new walkthrough may have started meanwhile: then the pill is its.
            if !is_coaching(&handle) {
                overlay::hide_quietly_named(&handle, Surface::Coach);
            }
        });
}

fn show_pill<R: Runtime>(
    app: &AppHandle<R>,
    view: &PillView,
    monitor: Option<(ScreenRect, u32)>,
    arrow: Option<(i32, i32)>,
) {
    let Some(window) = overlay::ensure(app, Surface::Coach) else {
        return;
    };
    if let Some((monitor, dpi)) = monitor {
        let scale = f64::from(dpi.max(96)) / 96.0;
        overlay::place(&window, pill_spot(monitor, scale, arrow));
    }
    overlay::dispatch(app, Surface::Coach, PILL_SHOW, &json!(view));
    overlay::show_quietly(&window);
}

/// Forgets the walkthrough here (it ended on the server, or another device moved it on).
fn end_locally<R: Runtime>(app: &AppHandle<R>) {
    if let Some(mut s) = state(app) {
        s.session = None;
    }
    annotate::clear(app);
    overlay::hide_quietly_named(app, Surface::Coach);
}

/// The one-time notice that coach mode sees the whole monitor (decision 6).
fn show_notice_once<R: Runtime>(app: &AppHandle<R>) {
    if coach::take_coach_notice(app) {
        coach::notify(
            app,
            "While I coach you, I look at your whole screen each time you check a step, so I can see menus and dialogs. Nothing is saved.",
        );
    }
}

fn say<R: Runtime>(app: &AppHandle<R>, text: &str) {
    page::dispatch(app, page::SAY, json!({ "text": text }));
}

// ─── The pill's buttons ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PillAction {
    Done,
    Hint,
    Yes,
    No,
    Pause,
    Resume,
    Stop,
    /// Dismiss the finished pill.
    Close,
}

/// The progress pill's buttons. Done, Hint, No and Resume capture the screen first (the
/// student's own click, like the ink pill's Save; decision 10).
#[tauri::command(async)]
pub fn screen_coach_pill<R: Runtime>(
    window: WebviewWindow<R>,
    action: PillAction,
) -> Result<(), String> {
    require_surface(&window, Surface::Coach)?;
    let app = window.app_handle();
    if action == PillAction::Close {
        overlay::hide_quietly(&window);
        return Ok(());
    }
    if !is_coaching(app) {
        overlay::hide_quietly(&window);
        return Ok(());
    }
    match action {
        PillAction::Done => coach::capture_for_coach(app, CoachCapture::Check(StepEvent::Done)),
        PillAction::Hint | PillAction::No => {
            coach::capture_for_coach(app, CoachCapture::Check(StepEvent::Stuck))
        }
        PillAction::Resume => coach::capture_for_coach(app, CoachCapture::Resume),
        PillAction::Yes => send_event(app, StepEvent::Yes),
        PillAction::Pause => send_event(app, StepEvent::Pause),
        PillAction::Stop => send_event(app, StepEvent::Stop),
        PillAction::Close => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    //! End to end against real servers (S4's acceptance check, as far as a test can go): the dev
    //! API and web app must be running, with a Gemini key. Captures only a window this test
    //! draws itself: a mock spreadsheet. The walkthrough is planned on it; saying "done" without
    //! doing step 1 must be caught as a skipped step and answered with a hint.
    //!
    //! ```sh
    //! MEW_E2E_APP=http://localhost:3000 MEW_E2E_API=http://127.0.0.1:8000 \
    //!   INTERNAL_API_SECRET=… cargo test coach_e2e -- --ignored --nocapture
    //! ```
    use super::*;
    use crate::screen::ask::tests::{env_url, link_device, post_json};
    use crate::screen::config::Privacy;
    use crate::screen::pipeline::{self, Tools};
    use crate::screen::win::test_window::TestWindow;
    use crate::screen::win::{target, ComThread};

    fn coach(app: &tauri::Url, token: &str, path: &str, body: &[u8]) -> CoachReply {
        let (status, reply) = post_json(
            &app.join(path).unwrap(),
            &[
                "Content-Type: application/json".into(),
                format!("Authorization: Bearer {token}"),
            ],
            body,
        );
        assert_eq!(status, 200, "{path}: {}", String::from_utf8_lossy(&reply));
        parse_coach_reply(&reply).expect("a valid coach reply")
    }

    #[test]
    #[ignore = "needs the dev servers, a Gemini key, and an interactive desktop"]
    fn coach_e2e_plans_a_walkthrough_and_catches_a_skipped_step() {
        let (app, api) = (env_url("MEW_E2E_APP"), env_url("MEW_E2E_API"));
        let _com = ComThread::init().unwrap();
        let token = link_device(&app, &api);

        let window = TestWindow::show(
            &[
                "Book1 - Excel     File   Home   Insert   Page Layout   Formulas   Data",
                "      A          B          C          D",
                "1   Region     Month      Product    Sales",
                "2   North      Jan        Pens       120",
                "3   South      Jan        Pens       95",
                "4   North      Feb        Paper      210",
            ],
            1100,
        );
        let target = target::window_target(window.hwnd).unwrap();
        let mut tools = Tools::default();
        let start = pipeline::run_on(&mut tools, &target, &Privacy::default()).expect("capture");
        let started = coach(
            &app,
            &token,
            "api/screen/coach/start",
            start_body(
                "teach me how to make a pivot table",
                &start.meta,
                start.jpeg.as_slice(),
            )
            .as_slice(),
        );
        eprintln!("started: {started:?}");
        assert_eq!(started.status, CoachStatus::Active);
        assert!(started.total >= 3, "a real plan: {started:?}");
        let id = started.walkthrough_id.clone().unwrap();

        // "Done", with nothing done: the same screen again.
        let again = pipeline::run_on(&mut tools, &target, &Privacy::default()).expect("capture");
        drop(window);
        let checked = coach(
            &app,
            &token,
            "api/screen/coach/step",
            check_body(&id, StepEvent::Done, &again.meta, again.jpeg.as_slice()).as_slice(),
        );
        eprintln!("checked: {checked:?}");
        assert_eq!(checked.step, 1, "the skipped step wasn't detected");
        assert!(
            checked.hints_used == 1 || checked.phase == walkthrough::CoachPhase::Confirming,
            "a hint (or a question when unsure): {checked:?}"
        );

        let stopped = coach(
            &app,
            &token,
            "api/screen/coach/step",
            &event_body(&id, StepEvent::Stop),
        );
        assert_eq!(stopped.status, CoachStatus::Stopped);
    }
}
