//! "Quiz me on this" (Screen Coach S6, docs/SCREEN_COACH.md §2.5): 1–3 practice questions about
//! what's on the screen, asked there and then, each kept by the server as a recall card in the
//! review queue.
//!
//! 1. "Quiz me on this" over the hotkey (`start`) sends the capture (and the window's title, when
//!    it holds nothing sensitive) to the web app's server, which makes and keeps the questions.
//! 2. Each question is said and shown on the quiz card. The student answers by voice (the next
//!    hold's words go here, `on_words`), by typing in the card, or by picking a choice; the
//!    server grades it (the key never comes here) and the reply is said.
//! 3. "Skip", "next" and "stop" are words too, and buttons on the card.
//!
//! One request at a time (`busy`). Pausing Screen Coach ends the quiz at once (`end_quietly`);
//! the cards are already kept. The protocol, the words and the card's view are pure, in `quiz.rs`.

use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

use serde_json::json;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use super::account::{forget_revoked_token, wipe_string};
use super::coach::{self, ScreenCoach};
use super::frame::{FrameMeta, ScreenRect};
use super::overlay::{self, require_surface, Surface};
use super::page;
use super::pipeline::Captured;
use super::privacy::detect::{find_sensitive, RedactionRules};
use super::quiz::{
    answer_body, parse_answer_reply, parse_quiz_reply, quiz_body, word_of, Phase, Quiz, QuizWord,
    CARD_SIZE,
};
use super::source::clean_title;
use super::win::{credential, http, target};

/// Quiz card page events (desktop/overlay-src/quiz-card.ts).
const CARD_SHOW: &str = "mew:quiz-show";
/// The longest reply read (three questions, or an answer's line).
const MAX_REPLY_BYTES: usize = 16 * 1024;

#[derive(Default)]
struct QuizState {
    quiz: Option<Quiz>,
    busy: bool,
    /// Bumped when the quiz ends here: replies to earlier requests are dropped.
    generation: u64,
    /// The monitor it's on, and its DPI.
    monitor: Option<(ScreenRect, u32)>,
}

static STATE: Mutex<QuizState> = Mutex::new(QuizState {
    quiz: None,
    busy: false,
    generation: 0,
    monitor: None,
});

fn state() -> MutexGuard<'static, QuizState> {
    STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A quiz is on: the next hold's words are its answer (or skip, or stop).
pub fn takes_words<R: Runtime>(_app: &AppHandle<R>) -> bool {
    state().quiz.is_some()
}

// ─── Starting ────────────────────────────────────────────────────────────────────────────────

/// "Quiz me on this": questions about the captured screen.
pub fn start<R: Runtime>(app: &AppHandle<R>, captured: Captured) {
    let Some(generation) = claim(app) else {
        return;
    };
    let handle = app.clone();
    in_background(app, move || {
        let Captured { jpeg, meta, .. } = captured;
        let title = window_title(&meta);
        let body = quiz_body(&meta, title.as_deref(), jpeg.as_slice());
        drop(jpeg); // only the request body holds the image now
        let reply = post(&handle, "api/screen/quiz", body.as_slice());
        drop(body);
        if !owns(generation) {
            return;
        }
        let reply = reply.and_then(|bytes| {
            parse_quiz_reply(&bytes).ok_or_else(|| "I couldn't make a quiz just now.".to_owned())
        });
        match reply {
            Ok(reply) => match Quiz::new(reply.questions) {
                Some(quiz) => {
                    let first = quiz.current().map(|q| q.prompt.clone()).unwrap_or_default();
                    {
                        let mut s = state();
                        s.quiz = Some(quiz);
                        s.monitor = Some((meta.monitor, meta.dpi));
                    }
                    say(&handle, &format!("{} {first}", reply.speech));
                    show_card(&handle);
                }
                None => say(&handle, &reply.speech),
            },
            Err(message) => coach::notify(&handle, &message),
        }
        coach::settle(&handle);
    });
}

/// The window's title, kept with the cards ("From your screen: Lecture 5"), unless it holds
/// something the redaction rules would cover (an email address, a code…): then none.
fn window_title(meta: &FrameMeta) -> Option<String> {
    let app = meta.app.as_deref().unwrap_or("unknown.exe");
    let hwnd = windows::Win32::Foundation::HWND(meta.window? as *mut _);
    let title = clean_title(&target::window_title(hwnd), app)?;
    find_sensitive(&title, &RedactionRules::default())
        .is_empty()
        .then_some(title)
}

// ─── Answering ───────────────────────────────────────────────────────────────────────────────

/// The hold's words while a quiz is on: an answer, "skip", "next" or "stop".
pub fn on_words<R: Runtime>(app: &AppHandle<R>, transcript: &str) {
    let (word, answered) = {
        let s = state();
        let Some(quiz) = s.quiz.as_ref() else {
            return;
        };
        let answered = matches!(quiz.phase, Phase::Answered { .. });
        (word_of(transcript, quiz.current()), answered)
    };
    match word {
        QuizWord::Stop => finish(app),
        QuizWord::Next => advance(app),
        // Already graded: any words go on to the next question.
        QuizWord::Answer(_) | QuizWord::Nothing if answered => advance(app),
        QuizWord::Answer(text) => answer(app, text),
        QuizWord::Nothing => repeat(app),
    }
}

fn answer<R: Runtime>(app: &AppHandle<R>, text: String) {
    let check_id = {
        let mut s = state();
        let Some(quiz) = s.quiz.as_mut() else {
            return;
        };
        if quiz.phase != Phase::Asking {
            return;
        }
        let Some(id) = quiz.current().map(|q| q.check_id.clone()) else {
            return;
        };
        quiz.phase = Phase::Checking;
        id
    };
    let Some(generation) = claim(app) else {
        set_phase(Phase::Asking);
        return;
    };
    show_card(app);
    let handle = app.clone();
    in_background(app, move || {
        let reply = post(
            &handle,
            "api/screen/quiz/answer",
            &answer_body(&check_id, &text),
        );
        if !owns(generation) {
            return;
        }
        let reply = reply.and_then(|bytes| {
            parse_answer_reply(&bytes).ok_or_else(|| "I couldn't check that just now.".to_owned())
        });
        match reply {
            Ok(reply) => {
                if let Some(quiz) = state().quiz.as_mut() {
                    quiz.graded(reply.correct, reply.speech.clone());
                }
                say(&handle, &reply.speech);
            }
            Err(message) => {
                set_phase(Phase::Asking);
                coach::notify(&handle, &message);
            }
        }
        show_card(&handle);
        coach::settle(&handle);
    });
}

/// On to the next question, or the end.
fn advance<R: Runtime>(app: &AppHandle<R>) {
    let next = {
        let mut s = state();
        let Some(quiz) = s.quiz.as_mut() else {
            return;
        };
        if quiz.phase == Phase::Checking {
            return;
        }
        quiz.advance()
            .then(|| quiz.current().map(|q| q.prompt.clone()))
            .flatten()
    };
    match next {
        Some(prompt) => {
            say(app, &prompt);
            show_card(app);
        }
        None => finish(app),
    }
}

/// Says the question again (a bare hold during a quiz).
fn repeat<R: Runtime>(app: &AppHandle<R>) {
    let prompt = state()
        .quiz
        .as_ref()
        .and_then(|q| q.current().map(|q| q.prompt.clone()));
    if let Some(prompt) = prompt {
        say(app, &prompt);
    }
}

/// Ends the quiz with its closing line (the cards stay in the review).
fn finish<R: Runtime>(app: &AppHandle<R>) {
    let line = {
        let mut s = state();
        s.busy = false;
        s.generation += 1;
        s.quiz.take().map(|quiz| quiz.closing_line())
    };
    overlay::hide_quietly_named(app, Surface::Quiz);
    if let Some(line) = line {
        say(app, &line);
    }
}

/// Ends the quiz without a word (Screen Coach was paused or turned off).
pub fn end_quietly<R: Runtime>(app: &AppHandle<R>) {
    {
        let mut s = state();
        s.busy = false;
        s.generation += 1;
        s.quiz = None;
    }
    overlay::hide_quietly_named(app, Surface::Quiz);
}

fn set_phase(phase: Phase) {
    if let Some(quiz) = state().quiz.as_mut() {
        quiz.phase = phase;
    }
}

// ─── Talking to the server ───────────────────────────────────────────────────────────────────

/// Marks a request as on its way and returns its generation; None (and a word) if one already is.
fn claim<R: Runtime>(app: &AppHandle<R>) -> Option<u64> {
    let claimed = {
        let mut s = state();
        let free = !std::mem::replace(&mut s.busy, true);
        free.then_some(s.generation)
    };
    if claimed.is_none() {
        say(app, "One moment, I'm still on it.");
    }
    claimed
}

/// The request of `generation` is done: true if the quiz is still the one it was for.
fn owns(generation: u64) -> bool {
    let mut s = state();
    let current = s.generation == generation;
    if current {
        s.busy = false;
    }
    current
}

fn in_background<R: Runtime>(app: &AppHandle<R>, work: impl FnOnce() + Send + 'static) {
    let spawned = std::thread::Builder::new()
        .name("mew-screen-quiz".into())
        .spawn(work);
    if spawned.is_err() {
        state().busy = false;
        coach::notify(app, "Couldn't start the quiz just now.");
    }
}

/// POSTs `body` to `path` with the device token; the reply's bytes on a 200.
fn post<R: Runtime>(app: &AppHandle<R>, path: &str, body: &[u8]) -> Result<Vec<u8>, String> {
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
        if reply.len() + chunk.len() > MAX_REPLY_BYTES {
            too_large = true;
        } else {
            reply.extend_from_slice(chunk);
        }
    });
    headers.iter_mut().for_each(|header| wipe_string(header));
    let status =
        result.map_err(|_| "I couldn't reach Neb. Check your connection and try again.")?;
    // Timings and statuses only: never what was asked, answered or on screen.
    eprintln!(
        "[screen] quiz {path}: status {status} in {} ms",
        started.elapsed().as_millis()
    );
    match status {
        200 if !too_large => Ok(reply),
        401 => {
            forget_revoked_token(app);
            Err("Screen Coach was signed out of your Neb account. Connect again in Screen Coach settings.".into())
        }
        404 => Err("That question isn't there any more.".into()),
        429 => Err("You've had a lot of quizzes for now. Try again in a little while.".into()),
        503 => Err("Quizzes aren't available right now.".into()),
        _ => Err("I couldn't make a quiz just now. Try again in a moment.".into()),
    }
}

// ─── The card ────────────────────────────────────────────────────────────────────────────────

/// Shows the quiz card (bottom right of the quiz's monitor) with the current question.
fn show_card<R: Runtime>(app: &AppHandle<R>) {
    let (view, monitor) = {
        let s = state();
        let Some(quiz) = s.quiz.as_ref() else {
            return;
        };
        (json!(quiz.view()), s.monitor)
    };
    let Some(window) = overlay::ensure(app, Surface::Quiz) else {
        return;
    };
    if let Some((monitor, dpi)) = monitor {
        overlay::place(&window, card_spot(monitor, f64::from(dpi.max(96)) / 96.0));
    }
    overlay::dispatch(app, Surface::Quiz, CARD_SHOW, &view);
    overlay::show_quietly(&window);
}

/// The bottom-right corner of the monitor, clear of the taskbar's usual height.
fn card_spot(monitor: ScreenRect, scale: f64) -> ScreenRect {
    let (w, h) = (
        (CARD_SIZE.0 * scale).round() as i32,
        (CARD_SIZE.1 * scale).round() as i32,
    );
    let gap = (24.0 * scale).round() as i32;
    let taskbar = (48.0 * scale).round() as i32;
    let left = (monitor.right - w - gap).max(monitor.left);
    let top = (monitor.bottom - h - gap - taskbar).max(monitor.top);
    ScreenRect {
        left,
        top,
        right: left + w,
        bottom: top + h,
    }
}

fn say<R: Runtime>(app: &AppHandle<R>, text: &str) {
    page::dispatch(app, page::SAY, json!({ "text": text }));
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuizAction {
    /// Typed (or a choice picked): `text` is the answer.
    Answer,
    /// Skip this question, or go on once it's graded.
    Next,
    Stop,
}

/// The quiz card's buttons and its text box.
#[tauri::command(async)]
pub fn screen_quiz_card<R: Runtime>(
    window: WebviewWindow<R>,
    action: QuizAction,
    text: Option<String>,
) -> Result<(), String> {
    require_surface(&window, Surface::Quiz)?;
    let app = window.app_handle();
    if !takes_words(app) {
        overlay::hide_quietly(&window);
        return Ok(());
    }
    match action {
        QuizAction::Answer => {
            let text = super::protocol::clean_transcript(text.as_deref().unwrap_or(""));
            if text.is_empty() {
                return Err("Type an answer first.".into());
            }
            answer(app, text);
        }
        QuizAction::Next => advance(app),
        QuizAction::Stop => finish(app),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_card_sits_bottom_right_on_its_monitor() {
        let monitor = ScreenRect {
            left: 1920,
            top: 0,
            right: 3840,
            bottom: 1080,
        };
        let spot = card_spot(monitor, 1.0);
        assert_eq!((spot.right, spot.width(), spot.height()), (3816, 440, 264));
        assert!(spot.bottom <= monitor.bottom - 48);
        let tiny = ScreenRect {
            left: 0,
            top: 0,
            right: 300,
            bottom: 200,
        };
        let squeezed = card_spot(tiny, 2.0);
        assert_eq!((squeezed.left, squeezed.top), (0, 0));
    }
}
