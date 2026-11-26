//! Native study orchestration. Screenshots stay in Rust; only validated protocol replies
//! reach the bundled study surfaces. One study request runs at a time, including Watch.
use std::sync::{atomic::Ordering, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};

use super::{
    capture_session::{self, NativeFrame},
    overlay::{self, Surface},
    pipeline, runtime, service_call,
};
use crate::screen::{
    config::CONSENT_VERSION,
    glance,
    intent::{self, Intent},
    notes_marks::{self, NotesSource},
    page,
    protocol::{self, ScreenAction},
    quiz::{self, Phase, Quiz, QuizWord},
    secret::SecretBytes,
    sign_in::SignIn,
    walkthrough::{self, CoachStatus, Move, Session, StepEvent},
};

const EVERY: Duration = Duration::from_secs(6);
const MAX_ON: Duration = Duration::from_secs(45 * 60);

#[derive(Default)]
struct Watch {
    started: Option<Instant>,
    last: Option<Vec<u8>>,
    previous: Option<String>,
    refused: Option<String>,
    failures: u8,
    epoch: u64,
}
impl Watch {
    fn changed(&mut self, fingerprint: Vec<u8>) -> bool {
        if self
            .last
            .as_ref()
            .is_some_and(|before| !glance::changed(before, &fingerprint))
        {
            return false;
        }
        self.last = Some(fingerprint);
        true
    }
    fn failed(&mut self) -> bool {
        self.failures = self.failures.saturating_add(1);
        self.failures >= 3
    }
    fn expired(&self, now: Instant) -> bool {
        self.started
            .is_none_or(|t| now.saturating_duration_since(t) >= MAX_ON)
    }
}
#[derive(Default)]
struct State {
    epoch: u64,
    busy: bool,
    outstanding: bool,
    account: Option<[u8; 32]>,
    coach: Option<Session>,
    finished_coach: Option<Value>,
    quiz: Option<Quiz>,
    step: Option<(Vec<u8>, bool)>,
    watch: Option<Watch>,
    timer_started: bool,
    findings: Vec<String>,
    pending_control: Option<(String, StepEvent)>,
}
#[derive(Default)]
struct Study(Mutex<State>);
fn state(app: &AppHandle) -> Result<MutexGuard<'_, State>, String> {
    let managed = app
        .try_state::<Study>()
        .ok_or("Study services aren't ready.")?;
    Ok(managed.inner().0.lock().unwrap_or_else(|p| p.into_inner()))
}

pub fn setup(app: &AppHandle) -> Result<(), String> {
    for (surface, permission) in [
        (Surface::Notes, "allow-screen-notes-panel"),
        (Surface::Coach, "allow-screen-coach-pill"),
        (Surface::Quiz, "allow-screen-quiz-card"),
    ] {
        app.add_capability(
            tauri::ipc::CapabilityBuilder::new(format!("mac-study-{}", surface.label()))
                .local(true)
                .window(surface.label())
                .permission(permission),
        )
        .map_err(|_| "Couldn't configure study surfaces.")?;
    }
    if !app.manage(Study::default()) {
        return Err("Study services already initialized.".into());
    }
    Ok(())
}

fn account(app: &AppHandle) -> Option<[u8; 32]> {
    service_call::credential_stamp(app).ok()
}
fn ensure_owner(app: &AppHandle) -> Result<(), String> {
    let owner = account(app);
    let valid = state(app)?.account.is_none_or(|a| Some(a) == owner);
    if !valid {
        stop_all(app);
        return Err("Your account changed. Start this study session again.".into());
    }
    if owner.is_none() {
        return Err("Connect Screen Coach to your Neb account first.".into());
    }
    Ok(())
}
fn usable(app: &AppHandle) -> bool {
    runtime::of(app).is_ok_and(|r| {
        let (c, _) = r.snapshot();
        c.enabled && !c.paused && c.consent_version == CONSENT_VERSION && c.privacy.show_in_captures
    })
}
fn generation(app: &AppHandle) -> Result<u64, String> {
    Ok(runtime::of(app)?.generation.load(Ordering::Acquire))
}
#[derive(Clone, Copy)]
struct Ticket {
    epoch: u64,
    generation: u64,
    account: [u8; 32],
}
fn claim(app: &AppHandle) -> Result<Ticket, String> {
    if !usable(app) {
        return Err("Enable Screen Coach and visible overlays in local settings first.".into());
    }
    let owner = account(app).ok_or("Connect Screen Coach to your Neb account first.")?;
    let generation = generation(app)?;
    let mut s = state(app)?;
    if s.account.is_some_and(|a| a != owner) {
        s.epoch = s.epoch.wrapping_add(1);
        s.coach = None;
        s.finished_coach = None;
        s.findings.clear();
        s.pending_control = None;
        s.quiz = None;
        s.step = None;
        s.watch = None;
    }
    if s.outstanding {
        return Err("One moment, I'm still on it.".into());
    }
    s.account = Some(owner);
    s.busy = true;
    s.outstanding = true;
    Ok(Ticket {
        epoch: s.epoch,
        generation,
        account: owner,
    })
}
fn current(app: &AppHandle, ticket: Ticket) -> bool {
    usable(app)
        && generation(app).ok() == Some(ticket.generation)
        && account(app) == Some(ticket.account)
        && state(app).is_ok_and(|s| s.epoch == ticket.epoch && s.account == Some(ticket.account))
}
fn release(app: &AppHandle, ticket: Ticket) {
    if let Ok(mut s) = state(app) {
        s.outstanding = false;
        if s.epoch == ticket.epoch {
            s.busy = false;
        }
    }
}
fn hide(app: &AppHandle, surface: Surface) {
    if let Some(w) = app.get_webview_window(surface.label()) {
        let _ = overlay::hide(&w);
    }
}
/// Called on pause, disable, account change and app close. Replies already on their way lose
/// their ticket immediately; no remote stop request uploads a frame during revocation.
pub fn stop_all(app: &AppHandle) {
    if let Ok(mut s) = state(app) {
        s.epoch = s.epoch.wrapping_add(1);
        s.busy = false;
        s.account = None;
        s.coach = None;
        s.finished_coach = None;
        s.findings.clear();
        s.pending_control = None;
        s.quiz = None;
        s.step = None;
        s.watch = None;
    }
    for surface in [Surface::Coach, Surface::Quiz, Surface::Notes] {
        hide(app, surface);
    }
}
pub fn is_coaching(app: &AppHandle) -> bool {
    state(app).is_ok_and(|s| s.coach.is_some())
}
pub fn takes_words(app: &AppHandle) -> bool {
    state(app).is_ok_and(|s| s.quiz.is_some())
}
pub fn watching(app: &AppHandle) -> bool {
    state(app).is_ok_and(|s| s.watch.is_some())
}
pub fn active_walkthrough(app: &AppHandle) -> Option<String> {
    let owner = account(app)?;
    let s = state(app).ok()?;
    (s.account == Some(owner)).then_some(())?;
    s.coach.as_ref().filter(|s| !s.paused).map(|s| s.id.clone())
}
fn dispatch(app: &AppHandle, event: &'static str, value: Value, ticket: Ticket) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if !current(&handle, ticket) {
            return;
        }
        let Some(sign_in) = handle.try_state::<SignIn>() else {
            return;
        };
        let Some(window) = handle.get_webview_window(crate::MAIN) else {
            return;
        };
        if page::require_app_page(&window, sign_in.app_url()).is_ok() {
            page::dispatch(&handle, event, value);
        }
    });
}
fn say_ticket(app: &AppHandle, text: &str, ticket: Ticket) {
    dispatch(app, page::SAY, json!({"text":text}), ticket);
}
fn say(app: &AppHandle, text: &str) {
    let Ok(generation) = generation(app) else {
        return;
    };
    let Ok(s) = state(app) else {
        return;
    };
    let Some(account) = s.account else {
        return;
    };
    let ticket = Ticket {
        epoch: s.epoch,
        generation,
        account,
    };
    drop(s);
    say_ticket(app, text, ticket);
}

fn show(app: &AppHandle, surface: Surface, event: &'static str, value: Value, ticket: Ticket) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        // UI does not sample AX or acquire pixels. Credential scope + generation are checked
        // again after the main-queue hop so a queued completion cannot reopen an old panel.
        if !current(&handle, ticket) {
            return;
        }
        if let Ok(window) = overlay::ensure(&handle, surface) {
            if let Some(display) = super::target::main_display() {
                let (width, height) = match surface {
                    Surface::Coach => walkthrough::PILL_SIZE,
                    Surface::Quiz => quiz::CARD_SIZE,
                    _ => (380., 520.),
                };
                let d = display.points;
                if let Some(rect) = super::target::Rect::new(
                    (d.x + d.width - width - 24.).max(d.x),
                    (d.y + d.height - height - 72.).max(d.y),
                    width.min(d.width),
                    height.min(d.height),
                ) {
                    let _ = overlay::place(&window, rect);
                }
            }
            let _ = overlay::dispatch(&handle, surface, event, &value);
            let _ = overlay::show_quietly(&window);
        }
    });
}
fn show_quiz(app: &AppHandle, ticket: Ticket) {
    let view = state(app)
        .ok()
        .and_then(|s| s.quiz.as_ref().map(|q| json!(q.view())));
    if let Some(view) = view {
        show(app, Surface::Quiz, "mew:quiz-show", view, ticket);
    }
}
fn coach_view(s: &State) -> Option<Value> {
    s.coach
        .as_ref()
        .map(|c| json!(walkthrough::pill_view(c, s.busy)))
        .or_else(|| s.finished_coach.clone())
}
fn show_coach(app: &AppHandle, ticket: Ticket) {
    let view = state(app).ok().and_then(|s| coach_view(&s));
    if let Some(view) = view {
        show(app, Surface::Coach, "mew:coach-pill-show", view, ticket);
    } else {
        hide(app, Surface::Coach);
    }
}

#[derive(Debug)]
enum Work {
    Notes(bool),
    Start(String),
    Recheck(String),
    Resume,
    Step(String, StepEvent),
    Quiz,
    Answer(String, String),
    Watch(u64),
}
impl Work {
    fn needs_frame(&self) -> bool {
        !matches!(self, Self::Answer(..))
            && !matches!(self, Self::Step(_,event) if !event.needs_screen())
    }
}
fn enqueue(app: &AppHandle, work: Work) -> Result<(), String> {
    if let Work::Step(id, event) = &work {
        if matches!(event, StepEvent::Pause | StepEvent::Stop) {
            ensure_owner(app)?;
            let deferred = {
                let mut s = state(app)?;
                if s.outstanding {
                    s.epoch = s.epoch.wrapping_add(1);
                    s.pending_control = Some((id.clone(), *event));
                    if *event == StepEvent::Stop {
                        s.coach = None;
                        s.finished_coach = None;
                        s.step = None;
                    } else if let Some(session) = s.coach.as_mut() {
                        session.paused = true;
                    }
                    true
                } else {
                    false
                }
            };
            if deferred {
                hide(app, Surface::Coach);
                clear_actions(app);
                return Ok(());
            }
        }
    }
    let ticket = claim(app)?;
    let watch_epoch = if let Work::Watch(epoch) = &work {
        Some(*epoch)
    } else {
        None
    };
    let handle = app.clone();
    let spawn = std::thread::Builder::new()
        .name("neb-mac-study".into())
        .spawn(move || {
            let result = run(&handle, ticket, work);
            let valid = current(&handle, ticket);
            release(&handle, ticket);
            drain_control(&handle, ticket.account);
            if valid {
                if let Err(message) = result {
                    if let Some(epoch) = watch_epoch {
                        watch_failed(&handle, epoch, &message, ticket);
                        return;
                    }
                    if let Ok(mut s) = state(&handle) {
                        if let Some(q) = s.quiz.as_mut() {
                            if q.phase == Phase::Checking {
                                q.phase = Phase::Asking;
                            }
                        }
                    }
                    if !message.is_empty() {
                        say_ticket(&handle, &message, ticket);
                    }
                }
                show_coach(&handle, ticket);
                show_quiz(&handle, ticket);
            }
        });
    if spawn.is_err() {
        release(app, ticket);
        return Err("Couldn't start study request.".into());
    }
    Ok(())
}
fn drain_control(app: &AppHandle, owner: [u8; 32]) {
    if !usable(app) || account(app) != Some(owner) {
        return;
    }
    let pending = state(app).ok().and_then(|mut s| s.pending_control.take());
    if let Some((id, event)) = pending {
        if enqueue(app, Work::Step(id.clone(), event)).is_err() {
            if let Ok(mut s) = state(app) {
                if s.pending_control.is_none() {
                    s.pending_control = Some((id, event));
                }
            }
        }
    }
}
fn send(
    app: &AppHandle,
    ticket: Ticket,
    frame: Option<&NativeFrame>,
    path: &str,
    body: &[u8],
) -> Result<SecretBytes, String> {
    let cancelled =
        || !current(app, ticket) || frame.is_some_and(|f| !capture_session::is_current(app, f));
    if cancelled() {
        return Err(String::new());
    }
    let bytes = service_call::post_bound(app, path, body, &ticket.account, &cancelled).map_err(
        |e| match e {
            service_call::CallError::Cancelled => String::new(),
            _ => e.to_string(),
        },
    )?;
    if cancelled() {
        return Err(String::new());
    }
    Ok(bytes)
}
fn run(app: &AppHandle, ticket: Ticket, work: Work) -> Result<(), String> {
    if !current(app, ticket) {
        return Ok(());
    }
    let frame = work
        .needs_frame()
        .then(|| capture_session::capture_window(app, pipeline::Intent::Ask, ticket.generation))
        .transpose()?;
    if !current(app, ticket) {
        return Ok(());
    }
    let meta = frame.as_ref().map(NativeFrame::server_meta);
    match work {
        Work::Notes(all) => {
            let f = frame.as_ref().ok_or("No study capture.")?;
            let (config, _) = runtime::of(app)?.snapshot();
            let blocks = f.text().blocks(&config.privacy.redaction);
            if blocks.is_empty() {
                return Err("I couldn't read any text to compare with your notes.".into());
            }
            // notes_check_body has NO image or geometry field. The JPEG is never passed here.
            let body = notes_marks::notes_check_body(
                &blocks,
                meta.as_ref().and_then(|m| m.app.as_deref()),
                all,
                &NotesSource::default(),
            );
            let bytes = send(
                app,
                ticket,
                Some(f),
                "api/screen/notes-check",
                body.as_slice(),
            )?;
            let reply = notes_marks::parse_notes_reply(bytes.as_slice())
                .ok_or("I couldn't check your notes just now.")?;
            if !current(app, ticket) {
                return Ok(());
            }
            state(app)?.findings = reply.findings.iter().map(|f| f.id.clone()).collect();
            dispatch(app, page::SPEECH, json!({"text":reply.speech}), ticket);
            dispatch(app, page::NOTES_CHECKED, json!(reply), ticket);
            show(
                app,
                Surface::Notes,
                "mew:notes-panel-show",
                json!(reply),
                ticket,
            );
            let actions =
                notes_marks::notes_marks(&reply.findings, &blocks, meta.as_ref().unwrap().bounds);
            show_actions(
                app,
                f,
                reply.check_id.as_deref().unwrap_or("notes"),
                actions,
                false,
            )?;
        }
        Work::Quiz => {
            let f = frame.as_ref().ok_or("No study capture.")?;
            let body = quiz::quiz_body(meta.as_ref().unwrap(), None, f.captured.jpeg.as_slice());
            let bytes = send(app, ticket, Some(f), "api/screen/quiz", body.as_slice())?;
            let reply = quiz::parse_quiz_reply(bytes.as_slice())
                .ok_or("I couldn't make a quiz just now.")?;
            if !current(app, ticket) {
                return Ok(());
            }
            let quiz = Quiz::new(reply.questions);
            let prompt = quiz
                .as_ref()
                .and_then(|q| q.current())
                .map(|q| q.prompt.clone())
                .unwrap_or_default();
            state(app)?.quiz = quiz;
            say_ticket(app, &format!("{} {prompt}", reply.speech), ticket);
        }
        Work::Answer(id, text) => {
            let body = SecretBytes::from_vec(quiz::answer_body(&id, &text));
            let bytes = send(app, ticket, None, "api/screen/quiz/answer", body.as_slice())?;
            let reply = quiz::parse_answer_reply(bytes.as_slice())
                .ok_or("I couldn't check that answer just now.")?;
            if !current(app, ticket) {
                return Ok(());
            }
            if let Some(q) = state(app)?.quiz.as_mut() {
                q.graded(reply.correct, reply.speech.clone());
            }
            say_ticket(app, &reply.speech, ticket);
        }
        Work::Watch(epoch) => return watch_look(app, ticket, frame.as_ref().unwrap(), epoch),
        other => {
            let (path, body) = match other {
                Work::Start(goal) => (
                    "api/screen/coach/start",
                    walkthrough::start_body(
                        &goal,
                        meta.as_ref().unwrap(),
                        frame.as_ref().unwrap().captured.jpeg.as_slice(),
                    ),
                ),
                Work::Recheck(words) => (
                    "api/screen/coach/recheck",
                    walkthrough::recheck_body(
                        &words,
                        meta.as_ref().unwrap(),
                        frame.as_ref().unwrap().captured.jpeg.as_slice(),
                    ),
                ),
                Work::Resume => (
                    "api/screen/coach/resume",
                    walkthrough::resume_body(
                        meta.as_ref().unwrap(),
                        frame.as_ref().unwrap().captured.jpeg.as_slice(),
                    ),
                ),
                Work::Step(id, event) if event.needs_screen() => {
                    let f = frame.as_ref().unwrap();
                    if event == StepEvent::Done {
                        let fingerprint = glance::fingerprint(&f.captured.pixels);
                        let unchanged =
                            state(app)?.step.as_mut().is_some_and(|(before, answered)| {
                                if !*answered && !glance::changed(before, &fingerprint) {
                                    *answered = true;
                                    true
                                } else {
                                    false
                                }
                            });
                        if unchanged {
                            say_ticket(app,"I don't see anything change yet. Have a go at the step, then press Done.",ticket);
                            return Ok(());
                        }
                    }
                    (
                        "api/screen/coach/step",
                        walkthrough::check_body(
                            &id,
                            event,
                            meta.as_ref().unwrap(),
                            f.captured.jpeg.as_slice(),
                        ),
                    )
                }
                Work::Step(id, event) => (
                    "api/screen/coach/step",
                    SecretBytes::from_vec(walkthrough::event_body(&id, event)),
                ),
                _ => unreachable!(),
            };
            let bytes = send(app, ticket, frame.as_ref(), path, body.as_slice())?;
            let reply = walkthrough::parse_coach_reply(bytes.as_slice())
                .ok_or("Coach mode couldn't answer just now.")?;
            if !current(app, ticket) {
                return Ok(());
            }
            say_ticket(app, &reply.speech, ticket);
            if reply.status != CoachStatus::Declined {
                let mut s = state(app)?;
                s.coach = Session::after(&reply);
                s.finished_coach = if reply.status == CoachStatus::Completed {
                    Some(json!(walkthrough::finished_view(&reply)))
                } else {
                    None
                };
                s.step = frame
                    .as_ref()
                    .map(|f| (glance::fingerprint(&f.captured.pixels), false));
                drop(s);
                if let Some(f) = frame.as_ref() {
                    show_actions(
                        app,
                        f,
                        reply.walkthrough_id.as_deref().unwrap_or("coach"),
                        reply.actions.clone(),
                        true,
                    )?;
                } else {
                    clear_actions(app);
                }
                if reply.status == CoachStatus::Completed {
                    show(
                        app,
                        Surface::Coach,
                        "mew:coach-pill-show",
                        json!(walkthrough::finished_view(&reply)),
                        ticket,
                    );
                }
            }
        }
    }
    Ok(())
}

// Ink remains native. Root adapter applies capture-pixel -> Quartz transforms before rendering.
fn show_actions(
    app: &AppHandle,
    frame: &NativeFrame,
    seed: &str,
    actions: Vec<ScreenAction>,
    coaching: bool,
) -> Result<(), String> {
    super::annotate::show_actions(app, frame, seed, actions, coaching)
}
fn clear_actions(app: &AppHandle) {
    let _ = super::annotate::clear(app);
}

/// Claims only study intents. Other questions continue through the shared tutor, with
/// active_walkthrough supplying context for an ordinary question midway through a step.
pub fn route_words(app: &AppHandle, transcript: &str) -> Result<bool, String> {
    route_intent(
        app,
        transcript,
        intent::intent_of(transcript, is_coaching(app)),
    )
}
pub fn route_intent(app: &AppHandle, transcript: &str, requested: Intent) -> Result<bool, String> {
    ensure_owner(app)?;
    let text = protocol::clean_transcript(transcript);
    if takes_words(app) {
        quiz_words(app, &text)?;
        return Ok(true);
    }
    let work = match requested {
        Intent::NotesCheck { all } => Work::Notes(all),
        Intent::CoachStart => Work::Start(text),
        Intent::CoachRecheck => Work::Recheck(text),
        Intent::CoachResume => Work::Resume,
        Intent::Quiz => Work::Quiz,
        Intent::Coach(word) => {
            let session = state(app)?
                .coach
                .clone()
                .ok_or("No walkthrough is active.")?;
            match walkthrough::move_for(word, &session) {
                Move::Resume => Work::Resume,
                Move::Send(event) => Work::Step(session.id, event),
            }
        }
        _ => return Ok(false),
    };
    enqueue(app, work)?;
    Ok(true)
}

fn quiz_words(app: &AppHandle, words: &str) -> Result<(), String> {
    let (word, answered) = {
        let s = state(app)?;
        let Some(q) = &s.quiz else {
            return Ok(());
        };
        (
            quiz::word_of(words, q.current()),
            matches!(q.phase, Phase::Answered { .. }),
        )
    };
    match word {
        QuizWord::Stop => finish_quiz(app),
        QuizWord::Next => advance_quiz(app),
        QuizWord::Answer(_) | QuizWord::Nothing if answered => advance_quiz(app),
        QuizWord::Answer(text) => answer_quiz(app, text),
        QuizWord::Nothing => {
            let prompt = state(app)?
                .quiz
                .as_ref()
                .and_then(|q| q.current())
                .map(|q| q.prompt.clone());
            if let Some(prompt) = prompt {
                say(app, &prompt);
            }
            Ok(())
        }
    }
}
fn answer_quiz(app: &AppHandle, text: String) -> Result<(), String> {
    let id = {
        let mut s = state(app)?;
        let q = s.quiz.as_mut().ok_or("No quiz is active.")?;
        if q.phase != Phase::Asking {
            return Ok(());
        }
        let id = q
            .current()
            .ok_or("No question is active.")?
            .check_id
            .clone();
        q.phase = Phase::Checking;
        id
    };
    if let Err(error) = enqueue(app, Work::Answer(id, text)) {
        if let Some(q) = state(app)?.quiz.as_mut() {
            q.phase = Phase::Asking;
        }
        return Err(error);
    }
    Ok(())
}
fn advance_quiz(app: &AppHandle) -> Result<(), String> {
    let prompt = {
        let mut s = state(app)?;
        let Some(q) = s.quiz.as_mut() else {
            return Ok(());
        };
        if q.phase == Phase::Checking {
            return Ok(());
        }
        if q.advance() {
            q.current().map(|q| q.prompt.clone())
        } else {
            None
        }
    };
    if let Some(prompt) = prompt {
        say(app, &prompt);
        refresh_quiz(app);
        Ok(())
    } else {
        finish_quiz(app)
    }
}
fn refresh_quiz(app: &AppHandle) {
    if let (Ok(s), Ok(generation)) = (state(app), generation(app)) {
        if let Some(account) = s.account {
            let ticket = Ticket {
                epoch: s.epoch,
                generation,
                account,
            };
            drop(s);
            show_quiz(app, ticket);
        }
    }
}
fn finish_quiz(app: &AppHandle) -> Result<(), String> {
    let line = {
        let mut s = state(app)?;
        s.epoch = s.epoch.wrapping_add(1);
        s.busy = false;
        s.quiz.take().map(|q| q.closing_line())
    };
    hide(app, Surface::Quiz);
    if let Some(line) = line {
        say(app, &line);
    }
    Ok(())
}

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
    Close,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuizAction {
    Answer,
    Next,
    Stop,
}
#[tauri::command]
pub fn screen_coach_pill(window: WebviewWindow, action: PillAction) -> Result<(), String> {
    overlay::require_surface(&window, Surface::Coach)?;
    let app = window.app_handle();
    ensure_owner(app)?;
    if action == PillAction::Close {
        state(app)?.finished_coach = None;
        hide(app, Surface::Coach);
        return Ok(());
    }
    let session = state(app)?
        .coach
        .clone()
        .ok_or("No walkthrough is active.")?;
    let work = match action {
        PillAction::Resume => Work::Resume,
        PillAction::Done => Work::Step(session.id, StepEvent::Done),
        PillAction::Hint | PillAction::No => Work::Step(session.id, StepEvent::Stuck),
        PillAction::Yes => Work::Step(session.id, StepEvent::Yes),
        PillAction::Pause => Work::Step(session.id, StepEvent::Pause),
        PillAction::Stop => Work::Step(session.id, StepEvent::Stop),
        PillAction::Close => unreachable!(),
    };
    enqueue(app, work)
}
#[tauri::command]
pub fn screen_quiz_card(
    window: WebviewWindow,
    action: QuizAction,
    text: Option<String>,
) -> Result<(), String> {
    overlay::require_surface(&window, Surface::Quiz)?;
    let app = window.app_handle();
    ensure_owner(app)?;
    match action {
        QuizAction::Answer => {
            let text = protocol::clean_transcript(text.as_deref().unwrap_or(""));
            if text.is_empty() {
                return Err("Type an answer first.".into());
            }
            answer_quiz(app, text)
        }
        QuizAction::Next => advance_quiz(app),
        QuizAction::Stop => finish_quiz(app),
    }
}
#[tauri::command]
pub fn screen_notes_panel(
    window: WebviewWindow,
    action: String,
    finding_id: Option<String>,
) -> Result<(), String> {
    overlay::require_surface(&window, Surface::Notes)?;
    let app = window.app_handle();
    ensure_owner(app)?;
    match action.as_str() {
        "close" => hide(app, Surface::Notes),
        "hide_marks" => clear_actions(app),
        "open_line" => {
            let id = finding_id
                .filter(|id| protocol::is_uuid(id))
                .ok_or("Not allowed.")?;
            if !state(app)?.findings.contains(&id) {
                return Err("Not allowed.".into());
            }
            page::dispatch(app, page::NOTES_OPEN, json!({"findingId":id}));
            if let Some(main) = app.get_webview_window(crate::MAIN) {
                let _ = main.show();
                let _ = main.unminimize();
                let _ = main.set_focus();
            }
        }
        _ => return Err("Not allowed.".into()),
    }
    Ok(())
}

fn externally_engaged(app: &AppHandle) -> bool {
    super::ask::engaged(app)
        || super::hand::engaged(app)
        || super::circle::has_session(app)
        || super::cursor_runtime::engaged(app)
        || super::drawing::view(app).0 != crate::screen::island::Tool::None
}
pub fn toggle_watch(app: &AppHandle) -> Result<(), String> {
    if watching(app) {
        stop_watch(app);
        return Ok(());
    }
    let ticket = claim(app)?;
    let start_timer = {
        let mut s = state(app)?;
        s.busy = false;
        s.outstanding = false;
        // Watch restart has its own epoch and does not cancel an unrelated active session.
        s.watch = Some(Watch {
            started: Some(Instant::now()),
            epoch: s.epoch,
            ..Watch::default()
        });
        let start = !s.timer_started;
        s.timer_started = true;
        start
    };
    if start_timer {
        let handle = app.clone();
        if std::thread::Builder::new()
            .name("neb-mac-watch".into())
            .spawn(move || loop {
                std::thread::park_timeout(EVERY);
                let external_engaged = externally_engaged(&handle);
                let owner = account(&handle);
                let usable = usable(&handle);
                let decision = {
                    let Ok(s) = state(&handle) else {
                        return;
                    };
                    let Some(w) = s.watch.as_ref() else {
                        continue;
                    };
                    if !usable || owner != s.account || w.expired(Instant::now()) {
                        None
                    } else if external_engaged
                        || s.outstanding
                        || s.coach.is_some()
                        || s.quiz.is_some()
                    {
                        continue;
                    } else {
                        Some(w.epoch)
                    }
                };
                if let Some(epoch) = decision {
                    let _ = enqueue(&handle, Work::Watch(epoch));
                } else {
                    stop_watch(&handle);
                }
            })
            .is_err()
        {
            state(app)?.timer_started = false;
            stop_watch(app);
            return Err("Couldn't start Watch.".into());
        }
    }
    let _ = ticket;
    say(
        app,
        "Watch is on: I'll look at your screen every few seconds and tell you if I see a slip.",
    );
    Ok(())
}
pub fn stop_watch(app: &AppHandle) {
    if let Ok(mut s) = state(app) {
        if s.watch.take().is_some() {
            s.epoch = s.epoch.wrapping_add(1);
            s.busy = false;
        }
    }
}
fn watch_look(
    app: &AppHandle,
    ticket: Ticket,
    frame: &NativeFrame,
    epoch: u64,
) -> Result<(), String> {
    if externally_engaged(app) {
        return Ok(());
    }
    let fingerprint = glance::fingerprint(&frame.captured.pixels);
    let previous = {
        let mut s = state(app)?;
        let Some(w) = s.watch.as_mut().filter(|w| w.epoch == epoch) else {
            return Ok(());
        };
        if !w.changed(fingerprint) {
            return Ok(());
        }
        w.previous.clone()
    };
    let help = runtime::of(app)?.snapshot().0.help;
    let body = crate::screen::watch::watch_body(
        &frame.server_meta(),
        help,
        previous.as_deref(),
        frame.captured.jpeg.as_slice(),
    );
    let response = send(
        app,
        ticket,
        Some(frame),
        "api/screen/watch",
        body.as_slice(),
    );
    let reply = response.and_then(|bytes| {
        crate::screen::watch::parse_watch_reply(bytes.as_slice())
            .ok_or("Invalid Watch reply.".into())
    });
    if !current(app, ticket) || externally_engaged(app) {
        return Ok(());
    }
    match reply {
        Ok(reply) => {
            {
                let mut s = state(app)?;
                let Some(w) = s.watch.as_mut().filter(|w| w.epoch == epoch) else {
                    return Ok(());
                };
                w.failures = 0;
                w.refused = None;
            }
            if let crate::screen::watch::WatchReply::Mistake {
                speech,
                actions,
                turn_id,
            } = reply
            {
                // Quiet never speaks out or draws unsolicited working. The server receives the
                // selected help level too, and applies its pedagogical restrictions.
                if help == crate::screen::config::HelpLevel::Quiet {
                    return Ok(());
                }
                let mut s = state(app)?;
                let w = s.watch.as_mut().ok_or("Watch ended.")?;
                if w.previous.as_deref() == Some(&speech) {
                    return Ok(());
                }
                w.previous = Some(speech.clone());
                drop(s);
                say_ticket(app, &speech, ticket);
                show_actions(app, frame, &turn_id, actions, false)?;
            }
        }
        Err(error) => return Err(error),
    }
    Ok(())
}

fn watch_failed(app: &AppHandle, epoch: u64, message: &str, ticket: Ticket) {
    let stop = {
        let Ok(mut s) = state(app) else {
            return;
        };
        let Some(w) = s.watch.as_mut().filter(|w| w.epoch == epoch) else {
            return;
        };
        let stop = w.failed();
        if w.refused.as_deref() != Some(message) && !message.is_empty() {
            w.refused = Some(message.to_owned());
            say_ticket(
                app,
                "Watch can't look right now. Check the active app and your screen permissions.",
                ticket,
            );
        }
        stop
    };
    if stop {
        stop_watch(app);
        say(
            app,
            "Watch is off after three failed looks. Turn it on again when you're ready.",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::{
        frame::ScreenRect,
        privacy::{
            detect::RedactionRules,
            redact::{OcrLine, OcrWord},
        },
        screen_text::ScreenText,
    };

    const ID: &str = "00000000-0000-4000-8000-000000000001";
    /// Test capture contains ordinary study text and a synthetic secret. No native permission,
    /// OS capture, Keychain, network or provider call is made by these fixtures.
    fn fake_capture() -> ScreenText {
        let lines = ["Mitochondria release energy", "student@example.com"]
            .into_iter()
            .enumerate()
            .map(|(n, text)| OcrLine {
                words: vec![OcrWord {
                    text: text.into(),
                    x: 20.,
                    y: 20. + n as f32 * 50.,
                    width: 240.,
                    height: 20.,
                }],
            })
            .collect::<Vec<_>>();
        ScreenText::from_ocr(
            &lines,
            (1., 1.),
            (640, 480),
            ScreenRect {
                left: 0,
                top: 0,
                right: 640,
                bottom: 480,
            },
            &[],
        )
    }
    struct FakeApi {
        calls: usize,
        reply: Vec<u8>,
    }
    impl FakeApi {
        fn post(&mut self, body: &[u8]) -> Vec<u8> {
            let body: Value = serde_json::from_slice(body).unwrap();
            assert!(body.get("image").is_none());
            assert!(body.get("jpeg").is_none());
            assert!(body.get("bounds").is_none());
            let encoded = body.to_string();
            assert!(!encoded.contains("student@example.com"));
            self.calls += 1;
            self.reply.clone()
        }
    }
    #[test]
    fn completed_coach_view_survives_generic_worker_refresh_until_closed() {
        let finished = json!({"phase":"finished","text":"Completed"});
        let mut s = State {
            finished_coach: Some(finished.clone()),
            ..Default::default()
        };
        assert!(s.coach.is_none());
        assert_eq!(coach_view(&s), Some(finished));
        s.finished_coach = None;
        assert_eq!(coach_view(&s), None);
    }
    #[test]
    fn notes_capture_redacts_text_and_sends_no_image_or_positions() {
        let capture = fake_capture();
        // Email redaction is an explicit user setting; cards/secrets/codes are defaults.
        let rules = RedactionRules {
            emails: true,
            ..RedactionRules::default()
        };
        let blocks = capture.blocks(&rules);
        assert_eq!(blocks.len(), 1);
        let body = notes_marks::notes_check_body(
            &blocks,
            Some("org.example.study"),
            true,
            &NotesSource::default(),
        );
        let mut api=FakeApi{calls:0,reply:br#"{"checkId":null,"related":true,"topic":"Biology","speech":"The text matches.","scopeLabel":"All notes","pages":[],"findings":[],"latencyMs":20}"#.to_vec()};
        let reply = notes_marks::parse_notes_reply(&api.post(body.as_slice())).unwrap();
        assert_eq!(api.calls, 1);
        assert!(reply.findings.is_empty());
        let payload: Value = serde_json::from_slice(body.as_slice()).unwrap();
        assert_eq!(payload["scope"], "all");
        assert_eq!(payload["screen"][0]["text"], "Mitochondria release energy");
    }
    #[test]
    fn malformed_replies_cannot_become_a_panel_or_ink() {
        assert!(notes_marks::parse_notes_reply(
            br#"{"speech":"Looks good","findings":[{"id":"javascript:alert(1)"}]}"#
        )
        .is_none());
        assert!(walkthrough::parse_coach_reply(br#"{"walkthroughId":"bad","title":"","status":"active","phase":"awaiting","step":1,"total":1,"hintsUsed":0,"speech":"Go","actions":[]}"#).is_none());
        assert!(quiz::parse_quiz_reply(br#"{"speech":"Start","questions":[{"checkId":"bad","prompt":"Q","kind":"short","choices":[]}]}"#).is_none());
        assert!(crate::screen::watch::parse_watch_reply(
            format!(r#"{{"status":"mistake","speech":"Hi\u0000","turnId":"{ID}","actions":[]}}"#)
                .as_bytes()
        )
        .is_none());
    }
    #[test]
    fn watch_fake_clock_stops_at_exact_limit_and_three_failures() {
        let now = Instant::now();
        let mut watch = Watch {
            started: Some(now),
            ..Watch::default()
        };
        assert!(!watch.expired(now + MAX_ON - Duration::from_millis(1)));
        assert!(watch.expired(now + MAX_ON));
        assert!(!watch.failed());
        assert!(!watch.failed());
        assert!(watch.failed());
    }
    #[test]
    fn watch_never_reuploads_same_screen_but_detects_a_real_change() {
        let mut watch = Watch::default();
        let dark = vec![0; 64 * 40];
        assert!(watch.changed(dark.clone()));
        assert!(!watch.changed(dark));
        assert!(watch.changed(vec![200; 64 * 40]));
        assert!(!watch.changed(vec![200; 64 * 40]));
    }
    #[test]
    fn steps_only_capture_for_explicit_visual_checks() {
        assert!(!Work::Step(ID.into(), StepEvent::Stop).needs_frame());
        assert!(!Work::Step(ID.into(), StepEvent::Pause).needs_frame());
        assert!(!Work::Step(ID.into(), StepEvent::Yes).needs_frame());
        assert!(!Work::Answer(ID.into(), "Answer".into()).needs_frame());
        assert!(Work::Step(ID.into(), StepEvent::Done).needs_frame());
        assert!(Work::Step(ID.into(), StepEvent::Stuck).needs_frame());
        assert!(Work::Resume.needs_frame());
        assert!(Work::Recheck("try again".into()).needs_frame());
    }
    #[test]
    fn quiz_grading_and_skip_keep_server_created_review_cards() {
        let reply = format!(
            r#"{{"speech":"Let's practice","questions":[{{"checkId":"{ID}","prompt":"What is ATP?","kind":"short","choices":[]}},{{"checkId":"00000000-0000-4000-8000-000000000002","prompt":"What is respiration?","kind":"short","choices":[]}}]}}"#
        );
        let mut quiz =
            Quiz::new(quiz::parse_quiz_reply(reply.as_bytes()).unwrap().questions).unwrap();
        assert_eq!(quiz::word_of("skip", quiz.current()), QuizWord::Next);
        assert!(quiz.advance());
        let grade =
            quiz::parse_answer_reply(br#"{"correct":true,"speech":"That's right."}"#).unwrap();
        quiz.graded(grade.correct, grade.speech);
        assert!(!quiz.advance());
        assert!(quiz.closing_line().contains("1 of 1 right"));
        assert!(quiz.closing_line().contains("review"));
    }
}
