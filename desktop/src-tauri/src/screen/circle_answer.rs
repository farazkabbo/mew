//! Circle & Ask's answer (S3.2 §2.4–2.5, §3.4–3.6): asking, playing the explanation step by
//! step, and saving it to the notebook.
//!
//! 1. `ask` builds the request on the capture worker: the **focus image** (the marks' area plus
//!    15 %, with the marks drawn on this copy only), the **context image** (the window, small),
//!    each mark's words and the text nearby. The pixels stay in wipeable buffers.
//! 2. The answer streams back step by step; each step goes to `Playback` (`circle_steps.rs`),
//!    whose cues draw its ink (the S3 ink overlay, one step at a time), show its caption, and
//!    have the page say it.
//! 3. When it ends, the toast: after 5 s the explanation is saved as a notebook entry (or on
//!    Open, or on Save when the setting is "ask each time"). Undo saves nothing. Follow-ups in
//!    the same session are added to the same entry.

use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use super::account::{forget_revoked_token, wipe_string};
use super::circle::{self, with_session, Mark, Session, Stage, CARD_SHOW};
use super::circle_protocol::{
    ask_body, parse_circle_event, parse_read_question, questions_in, read_question_body, AskHead,
    BlockOut, CircleEvent, ContentKind, Jpeg, MarkOut, Question, SourceOut, Step, Turn,
    CONFIRM_BELOW,
};
use super::circle_steps::{Cue, Playback, Voice};
use super::clip::{self, EntryCapture, EntryDraft};
use super::coach::{self, ScreenCoach};
use super::config::SaveMode;
use super::frame::{FrameMeta, ScreenRect};
use super::image::{crop, downscale_bgra_to_bgr, looks_blank, Pixels};
use super::ink::{self, check_drawn, clip_strokes_kept, DrawnInk, InkStroke, InkTool, Rect};
use super::marks::{self, to_normalised};
use super::overlay::{self, Surface};
use super::page;
use super::pipeline::{Captured, Tools};
use super::protocol::{Box2, EntryTurnOut, LineSplitter};
use super::raster::{draw_number, draw_polyline, STUDENT_INK};
use super::secret::SecretBytes;
use super::source::is_browser;
use super::win::encode::{encode_jpeg_with, FOR_MODEL};
use super::win::{credential, http, target};

/// The save toast's countdown (§2.5).
const TOAST_FOR: Duration = Duration::from_secs(5);
/// Circle & Ask's ink requests are numbered from here, so the overlay's reports can't be taken
/// for an ordinary answer's (`annotate.rs` numbers from 1).
pub const INK_IDS_FROM: u64 = 1 << 40;
/// The focus crop: the marks' box plus 15 % on each side (§3.4), and at least this big.
const FOCUS_PADDING: f32 = 0.15;
const FOCUS_MIN_CSS: f32 = 96.0;
/// The images' longest side (§3.4).
const IMAGE_LONG_SIDE: u32 = 1600;
const BLOCKS: usize = 40;
const BLOCK_CHARS: usize = 400;
const MARK_TEXT_CHARS: usize = 1_000;
const MAX_REPLY_LINE_BYTES: usize = 64 * 1024;
/// The student's marks in a saved entry: their ink, at this width (CSS pixels).
const STUDENT_WIDTH_CSS: f32 = 3.0;

/// An explanation in progress (or just played), for the current question.
pub(super) struct Answer {
    question: Question,
    steps: Vec<Step>,
    playback: Playback,
    ink_id: u64,
    /// What the ink overlay drew for each step (overlay pixels).
    drawn: Vec<(u8, Vec<InkStroke>)>,
    done: Option<Done>,
    /// The capture's area the steps' ink is placed over (the focus crop, screen pixels).
    focus: ScreenRect,
    /// The request is on its way (no step has come yet).
    waiting: bool,
    /// A step failed the safety check: nothing of this answer is kept.
    aborted: bool,
    /// The toast's countdown, while it runs.
    toast_until: Option<Instant>,
    /// Saved (or undone): the toast is over.
    settled: bool,
}

struct Done {
    read_question: String,
    summary: String,
    follow_up: Option<String>,
    concept_hints: Vec<String>,
}

/// Where a session's turns are saved, after the first one: the entry's clip, and how its image
/// was cut (the next turns' strokes are placed the same way).
pub(super) struct SavedEntry {
    clip_id: String,
    meta: FrameMeta,
    crop: Rect,
    scale: f32,
}

/// Something to do once the lock is released: a playback cue, or what the stream said.
enum Work {
    Play(Cue),
    /// A step failed the safety check: take back the ink, say this instead.
    Abort(String),
    Message(String),
}

fn plays(cues: Vec<Cue>) -> Vec<Work> {
    cues.into_iter().map(Work::Play).collect()
}

/// What a step control does (the card's buttons and Ctrl+Alt+. / Ctrl+Alt+,).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Pause,
    Resume,
    Repeat,
    Next,
}

// ─── Asking ──────────────────────────────────────────────────────────────────────────────────

/// Asks about the session's marks. If the capture isn't ready yet (Enter right after the first
/// mark), the question is kept and asked when it is.
pub fn ask<R: Runtime>(app: &AppHandle<R>, question: Question) {
    let ready = with_session(app, |session| {
        if session.marks.is_empty() || session.refused.is_some() {
            return Ready::No;
        }
        // A new question: whatever was playing stops; an earlier answer's toast keeps counting.
        if let Some(answer) = &mut session.answer {
            if !answer.playback.is_over() {
                answer.playback.stop();
            }
        }
        if session.capture.is_none() {
            if session.capturing {
                session.pending = Some(question.clone());
                return Ready::Later;
            }
            session.pending = Some(question.clone());
            session.capturing = true;
            return Ready::Capture;
        }
        session.stage = Stage::Answering;
        Ready::Now
    });
    match ready {
        Some(Ready::Now) => send(app, question),
        Some(Ready::Capture) => coach::capture_for_circle(app),
        Some(Ready::Later | Ready::No) | None => {}
    }
}

enum Ready {
    Now,
    Later,
    Capture,
    No,
}

/// A question kept while the capture was taken.
pub(super) fn ask_pending<R: Runtime>(app: &AppHandle<R>) {
    if let Some(question) = with_session(app, |s| s.pending.take()).flatten() {
        ask(app, question);
    }
}

/// Builds the request on the capture worker (it encodes JPEGs), then sends it on its own thread.
fn send<R: Runtime>(app: &AppHandle<R>, question: Question) {
    show_card(app, json!({ "mode": "thinking" }));
    let handle = app.clone();
    let queued = coach::on_worker(app, move |tools| {
        let Some(request) = build_request(&handle, tools, question.clone()) else {
            show_card_message(&handle, "I couldn't look at what you marked. Try again.");
            return;
        };
        start_answer(&handle, question, request.focus);
        let worker = handle.clone();
        let spawned = std::thread::Builder::new()
            .name("mew-circle-ask".into())
            .spawn(move || stream_answer(&worker, request));
        if spawned.is_err() {
            show_card_message(&handle, "I couldn't ask about that just now.");
        }
    });
    if !queued {
        show_card_message(app, "I couldn't ask about that just now.");
    }
}

/// The request, ready to send: its body holds both images (wiped on drop).
struct Request {
    body: SecretBytes,
    focus: ScreenRect,
    session_id: String,
}

fn build_request<R: Runtime>(
    app: &AppHandle<R>,
    tools: &mut Tools,
    question: Question,
) -> Option<Request> {
    let settings = coach::circle_settings(app);
    let rules = coach::privacy_of(app).redaction;
    // The capture is taken out while the images are made (no lock held), then put back.
    let (captured, session_id, history, marks_view) = with_session(app, |s| {
        let marks: Vec<MarkView> = s.marks.iter().map(MarkView::of).collect();
        (s.capture.take(), s.id.clone(), s.history.clone(), marks)
    })?;
    let captured = captured?;
    let built = (|| {
        let meta = &captured.meta;
        let detail = &captured.detail;
        let scale = meta.dpi.max(96) as f32 / 96.0;
        let focus = focus_rect(&marks_view, meta.bounds, scale)?;

        let mut focus_pixels = crop_screen(&detail.pixels, meta.bounds, focus)?;
        draw_marks(&mut focus_pixels, &marks_view, focus, scale);
        let focus_small = downscale_bgra_to_bgr(&focus_pixels, IMAGE_LONG_SIDE);
        drop(focus_pixels);
        let focus_jpeg = encode_jpeg_with(&focus_small, FOR_MODEL).ok()?;

        let window = meta
            .window
            .and_then(|raw| target::window_target(windows::Win32::Foundation::HWND(raw as *mut _)))
            .map(|t| t.bounds)
            .and_then(|b| intersect(b, meta.bounds))
            .unwrap_or(meta.bounds);
        let context_pixels = crop_screen(&detail.pixels, meta.bounds, window)?;
        let context_small = downscale_bgra_to_bgr(&context_pixels, IMAGE_LONG_SIDE);
        drop(context_pixels);
        let context_jpeg = encode_jpeg_with(&context_small, FOR_MODEL).ok()?;

        let marks = marks_view
            .iter()
            .map(|mark| MarkOut {
                number: mark.number,
                kind: mark.kind,
                region: to_box(mark.region, focus),
                polygon: if mark.kind == marks::MarkKind::Tap {
                    Vec::new()
                } else {
                    marks::simplified(&mark.points)
                        .into_iter()
                        .map(|p| to_normalised(p, focus))
                        .collect()
                },
                text: detail
                    .text
                    .text_of(&mark.targets, &rules)
                    .chars()
                    .take(MARK_TEXT_CHARS)
                    .collect(),
            })
            .collect();
        let near = grow(focus, 0.5);
        let blocks = detail
            .text
            .blocks(&rules)
            .into_iter()
            .filter(|block| target::overlaps(block.rect, near))
            .take(BLOCKS)
            .enumerate()
            .map(|(i, block)| BlockOut {
                id: format!("b{}", i + 1),
                text: block.text.chars().take(BLOCK_CHARS).collect(),
                region: to_box(block.rect, focus),
            })
            .collect();
        let source = settings
            .include_source_link
            .then(|| clip::notes_source(tools, meta, detail))
            .filter(|s| s.url.is_some())
            .map(|s| SourceOut {
                title: s.title,
                url: s.url,
            });
        let head = AskHead {
            session_id: session_id.clone(),
            question,
            marks,
            blocks,
            app: meta.app.clone(),
            kind: content_kind(meta, source.as_ref()),
            source,
            history,
        };
        let body = ask_body(
            &head,
            Jpeg {
                bytes: focus_jpeg.as_slice(),
                width: focus_small.width,
                height: focus_small.height,
            },
            (focus.width() as u32, focus.height() as u32),
            Jpeg {
                bytes: context_jpeg.as_slice(),
                width: context_small.width,
                height: context_small.height,
            },
        );
        Some(Request {
            body,
            focus,
            session_id,
        })
    })();
    // Put the capture back (or wipe it, if the session ended meanwhile).
    let back = with_session(app, |s| {
        if s.capture.is_none() {
            s.capture = Some(captured);
            None
        } else {
            Some(captured)
        }
    });
    drop(back);
    built
}

/// The parts of a mark the request needs (copied out of the session).
struct MarkView {
    number: u8,
    kind: marks::MarkKind,
    points: Vec<marks::Pt>,
    targets: Vec<usize>,
    region: ScreenRect,
}

impl MarkView {
    fn of(mark: &Mark) -> Self {
        let region = mark.region.unwrap_or_else(|| points_rect(&mark.points));
        Self {
            number: mark.number,
            kind: mark.kind,
            points: mark.points.clone(),
            targets: mark.targets.clone(),
            region,
        }
    }
}

fn points_rect(points: &[marks::Pt]) -> ScreenRect {
    let fold = points.iter().fold(
        (f32::MAX, f32::MAX, f32::MIN, f32::MIN),
        |(l, t, r, b), &(x, y)| (l.min(x), t.min(y), r.max(x), b.max(y)),
    );
    ScreenRect {
        left: fold.0.floor() as i32,
        top: fold.1.floor() as i32,
        right: fold.2.ceil() as i32,
        bottom: fold.3.ceil() as i32,
    }
}

/// The marks' box plus 15 % on each side (at least `FOCUS_MIN_CSS`), kept on the capture.
fn focus_rect(marks: &[MarkView], bounds: ScreenRect, scale: f32) -> Option<ScreenRect> {
    let union = super::screen_text::union(marks.iter().map(|m| m.region))?;
    let min = (FOCUS_MIN_CSS * scale) as i32;
    let pad_x = ((union.width() as f32 * FOCUS_PADDING) as i32).max((min - union.width()) / 2);
    let pad_y = ((union.height() as f32 * FOCUS_PADDING) as i32).max((min - union.height()) / 2);
    intersect(
        ScreenRect {
            left: union.left - pad_x,
            top: union.top - pad_y,
            right: union.right + pad_x,
            bottom: union.bottom + pad_y,
        },
        bounds,
    )
    .filter(|r| r.width() >= 16 && r.height() >= 16)
}

fn grow(rect: ScreenRect, by: f32) -> ScreenRect {
    let (dx, dy) = (
        (rect.width() as f32 * by) as i32,
        (rect.height() as f32 * by) as i32,
    );
    ScreenRect {
        left: rect.left - dx,
        top: rect.top - dy,
        right: rect.right + dx,
        bottom: rect.bottom + dy,
    }
}

fn intersect(a: ScreenRect, b: ScreenRect) -> Option<ScreenRect> {
    let r = ScreenRect {
        left: a.left.max(b.left),
        top: a.top.max(b.top),
        right: a.right.min(b.right),
        bottom: a.bottom.min(b.bottom),
    };
    (r.width() > 0 && r.height() > 0).then_some(r)
}

/// `rect` (screen pixels) as a 0–1000 box across `area`.
fn to_box(rect: ScreenRect, area: ScreenRect) -> Box2 {
    let a = to_normalised((rect.left as f32, rect.top as f32), area);
    let b = to_normalised((rect.right as f32, rect.bottom as f32), area);
    Box2 {
        left: a.x.min(b.x),
        top: a.y.min(b.y),
        right: a.x.max(b.x),
        bottom: a.y.max(b.y),
    }
}

/// The part of the capture on screen at `area` (the capture's pixels may be a little smaller
/// or bigger than the screen area it covers).
fn crop_screen(pixels: &Pixels, bounds: ScreenRect, area: ScreenRect) -> Option<Pixels> {
    let sx = pixels.width as f32 / bounds.width().max(1) as f32;
    let sy = pixels.height as f32 / bounds.height().max(1) as f32;
    let left = ((area.left - bounds.left) as f32 * sx).max(0.0) as u32;
    let top = ((area.top - bounds.top) as f32 * sy).max(0.0) as u32;
    let right = (((area.right - bounds.left) as f32 * sx).ceil() as u32).min(pixels.width);
    let bottom = (((area.bottom - bounds.top) as f32 * sy).ceil() as u32).min(pixels.height);
    (right > left + 8 && bottom > top + 8).then(|| crop(pixels, left, top, right, bottom))
}

/// The student's marks, drawn onto the focus image the model sees (numbered: §3.4).
fn draw_marks(image: &mut Pixels, marks: &[MarkView], focus: ScreenRect, scale: f32) {
    let sx = image.width as f32 / focus.width().max(1) as f32;
    let sy = image.height as f32 / focus.height().max(1) as f32;
    let to_image = |(x, y): marks::Pt| ((x - focus.left as f32) * sx, (y - focus.top as f32) * sy);
    for mark in marks {
        let points: Vec<_> = mark.points.iter().copied().map(to_image).collect();
        draw_polyline(image, &points, 3.0 * scale * sx, STUDENT_INK);
        if marks.len() > 1 {
            if let Some(&(x, y)) = points.first() {
                let cell = (2.0 * scale * sx).max(2.0);
                draw_number(
                    image,
                    mark.number,
                    (x - 9.0 * cell, y - 9.0 * cell),
                    cell,
                    STUDENT_INK,
                );
            }
        }
    }
}

fn content_kind(meta: &FrameMeta, source: Option<&SourceOut>) -> ContentKind {
    let app = meta.app.as_deref().unwrap_or("");
    let url = source.and_then(|s| s.url.as_deref()).unwrap_or("");
    if meta.video_playing.is_some() || url.contains("youtube.com") || url.contains("youtu.be") {
        ContentKind::Video
    } else if url.ends_with(".pdf")
        || matches!(
            app,
            "acrord32.exe" | "acrobat.exe" | "sumatrapdf.exe" | "foxitpdfreader.exe"
        )
    {
        ContentKind::Pdf
    } else if is_browser(app) {
        ContentKind::Browser
    } else {
        ContentKind::App
    }
}

// ─── The answer, step by step ────────────────────────────────────────────────────────────────

static NEXT_INK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(INK_IDS_FROM);

/// A new answer for the session: playback ready, waiting for its first step.
fn start_answer<R: Runtime>(app: &AppHandle<R>, question: Question, focus: ScreenRect) {
    let settings = coach::circle_settings(app);
    let voice = if settings.silent {
        Voice::Captions
    } else {
        Voice::Spoken
    };
    let animate = super::win::system::animations_enabled();
    let ink_id = NEXT_INK.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    with_session(app, |s| {
        s.stage = Stage::Answering;
        s.answer = Some(Answer {
            question,
            steps: Vec::new(),
            playback: Playback::new(voice, animate),
            ink_id,
            drawn: Vec::new(),
            done: None,
            focus,
            waiting: true,
            aborted: false,
            toast_until: None,
            settled: false,
        });
    });
    circle::set_keys(app, true);
    // The ink overlay goes on the marks' monitor, empty, ready for step 1.
    if let Some((monitor, window)) =
        with_session(app, |s| s.monitor).zip(overlay::ensure(app, Surface::Ink))
    {
        overlay::dispatch(app, Surface::Ink, "mew:ink-clear", &json!({}));
        overlay::place(&window, monitor);
        overlay::show_quietly(&window);
    }
}

fn stream_answer<R: Runtime>(app: &AppHandle<R>, request: Request) {
    let Request {
        body, session_id, ..
    } = request;
    let result = post(app, "api/screen/circle-ask", body.as_slice(), |line| {
        if let Some(event) = parse_circle_event(line) {
            on_event(app, &session_id, event);
        }
    });
    drop(body);
    let failure = match result {
        Ok(200) => None,
        Ok(429) => Some("You've asked a lot recently. Try again in a little while."),
        Ok(401) => {
            forget_revoked_token(app);
            Some("Screen Coach was signed out of your Neb account. Connect again in its settings.")
        }
        Ok(_) | Err(_) => Some("I couldn't explain that just now. Try again in a moment."),
    };
    // Whatever happened, no more steps will come.
    let cues = with_session(app, |s| {
        if s.id != session_id {
            return Vec::new();
        }
        s.answer
            .as_mut()
            .map(|a| {
                a.waiting = false;
                plays(a.playback.no_more_steps())
            })
            .unwrap_or_default()
    })
    .unwrap_or_default();
    if let Some(message) = failure {
        let nothing_played = with_session(app, |s| {
            s.answer.as_ref().is_none_or(|a| a.steps.is_empty())
        });
        if nothing_played == Some(true) {
            show_card_message(app, message);
        }
    }
    run(app, cues);
}

fn on_event<R: Runtime>(app: &AppHandle<R>, session_id: &str, event: CircleEvent) {
    let now = Instant::now();
    let cues = with_session(app, |s| {
        if s.id != session_id {
            return Vec::new();
        }
        let Some(answer) = s.answer.as_mut() else {
            return Vec::new();
        };
        match event {
            CircleEvent::Step { step } if step.index == answer.steps.len() && !answer.aborted => {
                answer.waiting = false;
                let words = step.say.split_whitespace().count();
                answer.steps.push(step);
                plays(answer.playback.step_arrived(words, now))
            }
            CircleEvent::Done {
                read_question,
                summary,
                follow_up_question,
                concept_hints,
                ..
            } => {
                answer.done = Some(Done {
                    read_question,
                    summary,
                    follow_up: follow_up_question,
                    concept_hints,
                });
                plays(answer.playback.no_more_steps())
            }
            CircleEvent::Abort { speech } => {
                answer.aborted = true;
                answer.steps.clear();
                answer.drawn.clear();
                // Silence, and no toast: nothing of this answer is kept.
                let mut work: Vec<Work> = answer
                    .playback
                    .stop()
                    .into_iter()
                    .filter(|c| *c == Cue::Hush)
                    .map(Work::Play)
                    .collect();
                work.push(Work::Abort(speech));
                work
            }
            CircleEvent::Error { message } => vec![Work::Message(message)],
            CircleEvent::Step { .. } => Vec::new(),
        }
    })
    .unwrap_or_default();
    run(app, cues);
}

/// Carries out playback cues (no lock is held while windows are told what to do).
fn run_cues<R: Runtime>(app: &AppHandle<R>, cues: Vec<Cue>) {
    run(app, plays(cues));
}

fn run<R: Runtime>(app: &AppHandle<R>, work: Vec<Work>) {
    for item in work {
        match item {
            Work::Play(Cue::Reveal(index)) => reveal(app, index),
            Work::Play(Cue::Caption(index)) => show_caption(app, index),
            Work::Play(Cue::Say { index, token }) => {
                let text = with_session(app, |s| {
                    s.answer
                        .as_ref()
                        .and_then(|a| a.steps.get(index))
                        .map(|st| st.say.clone())
                })
                .flatten();
                if let Some(text) = text {
                    page::dispatch(app, page::SAY, json!({ "text": text, "token": token }));
                }
            }
            Work::Play(Cue::Hush) => page::dispatch(app, page::HUSH, json!({})),
            Work::Play(Cue::Finished) => finished(app),
            Work::Abort(speech) => {
                overlay::dispatch(app, Surface::Ink, "mew:ink-clear", &json!({}));
                page::dispatch(app, page::SAY, json!({ "text": speech }));
                show_card_message(app, &speech);
                with_session(app, |s| s.stage = Stage::Answered);
            }
            Work::Message(message) => show_card_message(app, &message),
        }
    }
}

/// Draws step `index`'s ink beside the earlier steps' (planned on the overlay, clear of them).
fn reveal<R: Runtime>(app: &AppHandle<R>, index: usize) {
    let request = with_session(app, |s| {
        let answer = s.answer.as_ref()?;
        let step = answer.steps.get(index)?;
        let captured = s.capture.as_ref()?;
        // The steps' ink is in 0–1000 across the focus crop: draw it as if that were the capture.
        let mut meta = captured.meta.clone();
        meta.bounds = answer.focus;
        let mut request = ink::ink_request(
            answer.ink_id,
            &s.id,
            &step.actions,
            &meta,
            &captured.detail.text,
            super::win::system::animations_enabled(),
            super::win::system::contrast_highlight().as_deref(),
        );
        request.step = Some(index as u8);
        serde_json::to_value(&request).ok()
    })
    .flatten();
    if let Some(request) = request {
        overlay::dispatch(app, Surface::Ink, "mew:ink-draw", &request);
    }
}

/// The ink overlay drew a step: keep its strokes for the entry.
pub fn on_drawn<R: Runtime>(app: &AppHandle<R>, ink: DrawnInk) {
    with_session(app, |s| {
        let monitor = s.monitor;
        let Some(answer) = s.answer.as_mut().filter(|a| a.ink_id == ink.id) else {
            return;
        };
        let Some(step) = ink.step else {
            return;
        };
        if let Some(ink) = check_drawn(ink, monitor) {
            answer.drawn.retain(|(s, _)| *s != step);
            answer.drawn.push((step, ink.strokes));
        }
    });
}

/// The page finished saying the words with `token`.
pub fn spoken<R: Runtime>(app: &AppHandle<R>, token: u64) {
    let cues = with_session(app, |s| {
        s.answer
            .as_mut()
            .map(|a| a.playback.spoken(token, Instant::now()))
            .unwrap_or_default()
    })
    .unwrap_or_default();
    run_cues(app, cues);
}

/// The tracker's tick: playback deadlines and the toast's countdown.
pub fn tick<R: Runtime>(app: &AppHandle<R>, now: Instant) {
    let (cues, toast_over) = with_session(app, |s| {
        let Some(answer) = s.answer.as_mut() else {
            return (Vec::new(), false);
        };
        let cues = answer.playback.tick(now);
        let over = answer.toast_until.is_some_and(|at| now >= at) && !answer.settled;
        if over {
            answer.toast_until = None;
        }
        (cues, over)
    })
    .unwrap_or_default();
    run_cues(app, cues);
    if toast_over {
        save_now(app, false);
    }
}

pub fn control<R: Runtime>(app: &AppHandle<R>, control: Control) {
    let now = Instant::now();
    let cues = with_session(app, |s| {
        let Some(answer) = s.answer.as_mut() else {
            return Vec::new();
        };
        match control {
            Control::Pause => answer.playback.pause(),
            Control::Resume => answer.playback.resume(now),
            Control::Repeat => answer.playback.repeat(now),
            Control::Next => answer.playback.next(now),
        }
    })
    .unwrap_or_default();
    let paused = with_session(app, |s| {
        s.answer.as_ref().is_some_and(|a| a.playback.is_paused())
    });
    run_cues(app, cues);
    if paused == Some(true) {
        show_caption_paused(app);
    }
}

/// "Stop" or Esc: ends the explanation where it is. False if nothing was playing.
pub fn stop_if_playing<R: Runtime>(app: &AppHandle<R>) -> bool {
    let cues = with_session(app, |s| {
        s.answer
            .as_mut()
            .filter(|a| !a.playback.is_over())
            .map(|a| a.playback.stop())
    })
    .flatten();
    match cues {
        Some(cues) => {
            run_cues(app, cues);
            true
        }
        None => false,
    }
}

/// Barge-in (the student talks, types or draws again): the explanation stops where it is.
pub fn interrupt<R: Runtime>(app: &AppHandle<R>) {
    stop_if_playing(app);
}

/// The session ended: nothing more is said.
pub fn stopped<R: Runtime>(app: &AppHandle<R>) {
    page::dispatch(app, page::HUSH, json!({}));
}

/// What the pointer shows while a question is answered.
pub(super) fn look(session: &Session) -> super::pointer::PointerLook {
    match &session.answer {
        Some(a) if a.waiting => super::pointer::PointerLook::Thinking,
        Some(a) if !a.playback.is_over() => super::pointer::PointerLook::Explaining,
        _ => super::pointer::PointerLook::Idle,
    }
}

/// An explanation is waiting for its toast to end: its capture must stay (it's what's saved).
pub(super) fn has_unsaved_answer(session: &Session) -> bool {
    session
        .answer
        .as_ref()
        .is_some_and(|a| a.playback.is_over() && !a.settled && !a.aborted && !a.steps.is_empty())
}

// ─── After the explanation: the toast and saving ─────────────────────────────────────────────

/// The explanation ended (played out or stopped): remember it for follow-ups, and offer to save.
fn finished<R: Runtime>(app: &AppHandle<R>) {
    let settings = coach::circle_settings(app);
    let offer = with_session(app, |s| {
        s.stage = Stage::Answered;
        let answer = s.answer.as_mut()?;
        if answer.aborted || answer.steps.is_empty() || answer.settled {
            return None;
        }
        let summary = answer
            .done
            .as_ref()
            .map(|d| d.summary.clone())
            .unwrap_or_else(|| {
                answer
                    .steps
                    .iter()
                    .map(|st| st.say.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            });
        s.history.push(Turn {
            question: answer.question.label().to_owned(),
            summary: summary.chars().take(320).collect(),
        });
        if s.history.len() > 3 {
            s.history.remove(0);
        }
        let follow_up = answer.done.as_ref().and_then(|d| d.follow_up.clone());
        // Never saved automatically: when it's off, when blocked windows were blacked out under
        // the crop, or a protected (black) picture (§7.2).
        let masked = s
            .capture
            .as_ref()
            .is_some_and(|c| crop_touches_blackout(c, answer.focus));
        let blank = s
            .capture
            .as_ref()
            .and_then(|c| crop_screen(&c.detail.pixels, c.meta.bounds, answer.focus))
            .is_some_and(|p| looks_blank(&p));
        let auto = settings.save == SaveMode::Auto && !masked && !blank;
        if auto {
            answer.toast_until = Some(Instant::now() + TOAST_FOR);
        }
        Some((auto, settings.save, masked, blank, follow_up))
    })
    .flatten();
    let Some((auto, mode, masked, blank, follow_up)) = offer else {
        show_card(app, json!({ "mode": "ask", "followUp": null }));
        return;
    };
    let note = if blank {
        Some("This video is protected, so it can't be saved.")
    } else if masked {
        Some("Part of this area was hidden, so it isn't saved by itself.")
    } else {
        None
    };
    show_card(
        app,
        json!({
            "mode": "toast",
            "seconds": auto.then_some(TOAST_FOR.as_secs()),
            "canSave": !blank && mode != SaveMode::Never,
            "note": note,
            "followUp": follow_up,
        }),
    );
}

fn crop_touches_blackout(captured: &Captured, focus: ScreenRect) -> bool {
    let bounds = captured.meta.bounds;
    let pixels = &captured.detail.pixels;
    let sx = pixels.width as f32 / bounds.width().max(1) as f32;
    let sy = pixels.height as f32 / bounds.height().max(1) as f32;
    let (left, top) = (
        ((focus.left - bounds.left) as f32 * sx) as u32,
        ((focus.top - bounds.top) as f32 * sy) as u32,
    );
    let (right, bottom) = (
        ((focus.right - bounds.left) as f32 * sx) as u32,
        ((focus.bottom - bounds.top) as f32 * sy) as u32,
    );
    captured
        .detail
        .blacked_out
        .iter()
        .any(|r| r.left < right && left < r.right && r.top < bottom && top < r.bottom)
}

/// Undo: this explanation isn't saved (nothing was uploaded).
pub fn undo<R: Runtime>(app: &AppHandle<R>) {
    with_session(app, |s| {
        if let Some(answer) = s.answer.as_mut() {
            answer.settled = true;
            answer.toast_until = None;
        }
    });
    show_card(app, json!({ "mode": "ask", "note": "Not saved." }));
}

/// Saves the explanation now: the toast ended, or Open (`open`) or Save was pressed.
pub fn save_now<R: Runtime>(app: &AppHandle<R>, open: bool) {
    let settings = coach::circle_settings(app);
    let Some(save) =
        with_session(app, |s| take_for_saving(s, settings.include_source_link)).flatten()
    else {
        return;
    };
    let handle = app.clone();
    let queued = coach::on_worker(app, move |tools| {
        let outcome = match save {
            Saving::First {
                capture,
                include_link,
            } => save_first(&handle, tools, *capture, include_link, open),
            Saving::More { body, clip_id } => append(&handle, &body, &clip_id, open),
        };
        match outcome {
            Ok(()) => show_card(&handle, json!({ "mode": "saved", "open": open })),
            Err(message) => show_card_message(&handle, &message),
        }
    });
    if !queued {
        show_card_message(app, "I couldn't save that just now.");
    }
}

enum Saving {
    /// The session's first entry: the capture is cut and uploaded with it.
    First {
        capture: Box<EntryCapture>,
        include_link: bool,
    },
    /// A follow-up: its words and ink are added to the entry (no picture).
    More { body: Vec<u8>, clip_id: String },
}

/// Takes what an explanation's save needs out of the session (the capture goes with the first
/// save: the session can capture again for another mark).
fn take_for_saving(session: &mut Session, include_link: bool) -> Option<Saving> {
    let monitor = session.monitor;
    let scale = session.scale() as f32;
    let student: Vec<InkStroke> = session
        .marks
        .iter()
        .map(|mark| student_stroke(mark, monitor, scale))
        .collect();
    let answer = session.answer.as_mut()?;
    if answer.settled || answer.aborted || answer.steps.is_empty() {
        return None;
    }
    answer.settled = true;
    answer.toast_until = None;
    let (strokes, stroke_steps): (Vec<InkStroke>, Vec<u8>) = answer
        .drawn
        .iter()
        .flat_map(|(step, strokes)| strokes.iter().map(move |s| (s.clone(), *step)))
        .unzip();
    let turn = EntryTurnOut {
        question: answer
            .done
            .as_ref()
            .map(|d| d.read_question.clone())
            .unwrap_or_else(|| answer.question.label().to_owned()),
        steps: answer.steps.iter().map(|s| s.say.clone()).collect(),
        summary: answer
            .done
            .as_ref()
            .map(|d| d.summary.clone())
            .unwrap_or_else(|| answer.steps[0].say.clone()),
        follow_up_question: answer.done.as_ref().and_then(|d| d.follow_up.clone()),
    };
    let concept_hints = answer
        .done
        .as_ref()
        .map(|d| d.concept_hints.clone())
        .unwrap_or_default();
    let focus = answer.focus;

    if let Some(entry) = &session.entry {
        // Placed exactly as the first turn's strokes were.
        let kept = clip_strokes_kept(&strokes, &entry.meta, entry.crop, entry.scale);
        let body = serde_json::to_vec(&json!({
            "sessionId": session.id,
            "turn": turn,
            "strokes": kept.iter().map(|(_, s)| s).collect::<Vec<_>>(),
            "strokeSteps": kept.iter().map(|(i, _)| stroke_steps.get(*i).copied().unwrap_or(0)).collect::<Vec<_>>(),
            "conceptHints": concept_hints,
        }))
        .ok()?;
        return Some(Saving::More {
            body,
            clip_id: entry.clip_id.clone(),
        });
    }
    let captured = session.capture.take()?;
    let Captured { meta, detail, .. } = captured;
    let crop = [
        (focus.left - meta.bounds.left) as f32,
        (focus.top - meta.bounds.top) as f32,
        focus.width() as f32,
        focus.height() as f32,
    ];
    let link_default = meta.app.as_deref().is_some_and(is_browser);
    Some(Saving::First {
        capture: Box::new(EntryCapture {
            meta,
            detail,
            strokes,
            crop,
            entry: EntryDraft {
                session_id: session.id.clone(),
                student_strokes: student,
                turn,
                stroke_steps,
                concept_hints,
            },
        }),
        include_link: include_link && link_default,
    })
}

/// A mark as the student's own ink stroke, in overlay pixels (red, like on screen).
fn student_stroke(mark: &Mark, monitor: ScreenRect, scale: f32) -> InkStroke {
    InkStroke {
        tool: InkTool::Pen,
        color: super::ink::STUDENT_INK.to_owned(),
        width: STUDENT_WIDTH_CSS * scale,
        points: mark
            .points
            .iter()
            .enumerate()
            .map(|(i, (x, y))| {
                [
                    x - monitor.left as f32,
                    y - monitor.top as f32,
                    0.5,
                    i as f32 * 8.0,
                ]
            })
            .collect(),
    }
}

fn save_first<R: Runtime>(
    app: &AppHandle<R>,
    tools: &mut Tools,
    capture: EntryCapture,
    include_link: bool,
    open: bool,
) -> Result<(), String> {
    let meta = capture.meta.clone();
    let saved = clip::save_entry(app, tools, capture, include_link, open)?;
    with_session(app, |s| {
        s.entry = Some(SavedEntry {
            clip_id: saved.clip_id,
            meta,
            crop: saved.crop,
            scale: saved.scale,
        });
    });
    Ok(())
}

/// Adds a follow-up's words and ink to the session's entry.
fn append<R: Runtime>(
    app: &AppHandle<R>,
    body: &[u8],
    clip_id: &str,
    open: bool,
) -> Result<(), String> {
    let mut status = 0;
    let result = post(app, "api/screen/entries/append", body, |_| {});
    if let Ok(code) = result {
        status = code;
    }
    match status {
        200 | 204 => {
            page::dispatch(
                app,
                page::ENTRY_SAVED,
                json!({ "clipId": clip_id, "open": open }),
            );
            if open {
                clip::show_notebook(app);
            }
            Ok(())
        }
        401 => {
            forget_revoked_token(app);
            Err("Screen Coach was signed out of your Neb account.".to_owned())
        }
        _ => Err("I couldn't add that to your notebook just now.".to_owned()),
    }
}

/// "Edit crop": the explanation in S3's preview (the session ends: the preview has it now).
pub fn edit_crop<R: Runtime>(app: &AppHandle<R>) {
    let settings = coach::circle_settings(app);
    let saving = with_session(app, |s| take_for_saving(s, settings.include_source_link)).flatten();
    let Some(Saving::First { capture, .. }) = saving else {
        show_card_message(app, "This one is already in your notebook.");
        return;
    };
    let handle = app.clone();
    coach::on_worker(app, move |tools| clip::open_entry(&handle, tools, *capture));
    circle::end_session(app);
}

// ─── Reading a question from the screen ──────────────────────────────────────────────────────

/// The capture for "Select question on screen" arrived: printed text is read on the device;
/// handwriting is sent (that crop only) to be read (§3.5).
pub fn on_question_captured<R: Runtime>(app: &AppHandle<R>, area: ScreenRect, captured: Captured) {
    let rules = coach::privacy_of(app).redaction;
    let mut text = captured.detail.text.text_in(area, &rules);
    let printed = text.chars().filter(|c| c.is_alphabetic()).count() >= 3;
    if printed {
        let questions = questions_in(&text);
        wipe_string(&mut text);
        drop(captured);
        return offer_questions(app, questions, false, 1.0);
    }
    let image = crop_screen(&captured.detail.pixels, captured.meta.bounds, area)
        .map(|p| downscale_bgra_to_bgr(&p, 1200))
        .and_then(|small| {
            encode_jpeg_with(&small, FOR_MODEL)
                .ok()
                .map(|jpeg| (jpeg, small.width, small.height))
        });
    drop(captured);
    let Some((jpeg, width, height)) = image else {
        return show_card_message(app, "I couldn't read a question there. Type it instead.");
    };
    let body = read_question_body(Jpeg {
        bytes: jpeg.as_slice(),
        width,
        height,
    });
    drop(jpeg);
    let handle = app.clone();
    let _ = std::thread::Builder::new()
        .name("mew-circle-read".into())
        .spawn(move || {
            let mut reply = Vec::new();
            let status = post_whole(
                &handle,
                "api/screen/read-question",
                body.as_slice(),
                &mut reply,
            );
            drop(body);
            match (status, parse_read_question(&reply)) {
                (Ok(200), Some(read)) => {
                    offer_questions(&handle, read.questions, read.handwritten, read.confidence)
                }
                _ => show_card_message(&handle, "I couldn't read that. Type the question instead."),
            }
        });
}

/// One clear question is asked at once; several, or one read without confidence, are shown to
/// the student first (never guessed).
fn offer_questions<R: Runtime>(
    app: &AppHandle<R>,
    questions: Vec<String>,
    handwritten: bool,
    confidence: f32,
) {
    match questions.as_slice() {
        [] => show_card_message(app, "I couldn't find a question there. Type it instead."),
        [only] if confidence >= CONFIRM_BELOW => ask(
            app,
            Question::ScreenSelection {
                text: only.clone(),
                handwritten,
                confidence,
            },
        ),
        _ => show_card(app, json!({ "mode": "confirm", "questions": questions })),
    }
}

// ─── The card ────────────────────────────────────────────────────────────────────────────────

/// The ask bar, beside the first mark (§2.3).
pub fn show_ask_bar<R: Runtime>(app: &AppHandle<R>) {
    circle::set_keys(app, true);
    let silent = coach::circle_settings(app).silent;
    show_card(app, json!({ "mode": "ask", "silent": silent }));
}

pub fn show_card_message<R: Runtime>(app: &AppHandle<R>, text: &str) {
    show_card(app, json!({ "mode": "message", "text": text }));
}

fn show_caption<R: Runtime>(app: &AppHandle<R>, index: usize) {
    let view = with_session(app, |s| {
        let answer = s.answer.as_ref()?;
        let step = answer.steps.get(index)?;
        let (_, arrived) = answer.playback.position();
        Some(json!({
            "mode": "explain",
            "step": index + 1,
            "total": arrived.max(index + 1),
            "say": step.say,
            "paused": false,
            "silent": coach::circle_settings(app).silent,
        }))
    })
    .flatten();
    if let Some(view) = view {
        show_card(app, view);
    }
}

fn show_caption_paused<R: Runtime>(app: &AppHandle<R>) {
    let view = with_session(app, |s| {
        let answer = s.answer.as_ref()?;
        let (index, arrived) = answer.playback.position();
        let step = answer.steps.get(index)?;
        Some(json!({ "mode": "explain", "step": index + 1, "total": arrived, "say": step.say, "paused": true }))
    })
    .flatten();
    if let Some(view) = view {
        show_card(app, view);
    }
}

/// Shows the card beside the marks with `view` (its page renders it).
fn show_card<R: Runtime>(app: &AppHandle<R>, view: serde_json::Value) {
    let spot = with_session(app, |s| {
        let marks = super::screen_text::union(
            s.marks
                .iter()
                .map(|m| m.region.unwrap_or_else(|| points_rect(&m.points))),
        );
        (marks, s.monitor, s.scale())
    });
    let Some((marks, monitor, scale)) = spot else {
        return;
    };
    let Some(window) = overlay::ensure(app, Surface::Card) else {
        return;
    };
    let rect = card_spot(marks.unwrap_or(monitor), monitor, scale);
    overlay::place(&window, rect);
    overlay::dispatch(app, Surface::Card, CARD_SHOW, &view);
    overlay::show_quietly(&window);
}

/// Beside the marks: to the right if there's room, else to the left, else below them (or above);
/// always on the monitor (physical pixels).
pub fn card_spot(marks: ScreenRect, monitor: ScreenRect, scale: f64) -> ScreenRect {
    let (w, h) = (
        (overlay::CARD_SIZE.0 * scale).round() as i32,
        (overlay::CARD_SIZE.1 * scale).round() as i32,
    );
    let gap = (12.0 * scale).round() as i32;
    let fit_x = |left: i32| {
        left.clamp(
            monitor.left + gap,
            (monitor.right - w - gap).max(monitor.left),
        )
    };
    let fit_y = |top: i32| {
        top.clamp(
            monitor.top + gap,
            (monitor.bottom - h - gap).max(monitor.top),
        )
    };
    let (left, top) = if marks.right + gap + w <= monitor.right {
        (marks.right + gap, fit_y(marks.top))
    } else if marks.left - gap - w >= monitor.left {
        (marks.left - gap - w, fit_y(marks.top))
    } else if marks.bottom + gap + h <= monitor.bottom {
        (fit_x(marks.left), marks.bottom + gap)
    } else {
        (fit_x(marks.left), fit_y(marks.top - gap - h))
    };
    ScreenRect {
        left,
        top,
        right: left + w,
        bottom: top + h,
    }
}

/// The card page's commands are in `circle.rs`; this re-checks the main page's report.
#[tauri::command]
pub fn screen_coach_spoken<R: Runtime>(window: WebviewWindow<R>, token: u64) -> Result<(), String> {
    let app = window.app_handle();
    let coach = coach::coach_of(app)?;
    page::require_app_page(&window, coach.app_url())?;
    spoken(app, token);
    Ok(())
}

// ─── Network ─────────────────────────────────────────────────────────────────────────────────

/// POSTs `body` with the device token, handing each complete line of the reply to `on_line`.
fn post<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    body: &[u8],
    mut on_line: impl FnMut(&str),
) -> Result<u16, ()> {
    let coach = app.try_state::<ScreenCoach>().ok_or(())?;
    let token = credential::load().ok_or(())?;
    let token = std::str::from_utf8(token.as_slice()).map_err(|_| ())?;
    let url = coach.app_url().join(path).map_err(|_| ())?;
    let mut headers = [
        "Content-Type: application/json".to_owned(),
        format!("Authorization: Bearer {token}"),
    ];
    let started = Instant::now();
    let mut lines = LineSplitter::default();
    let result = http::post(&url, &headers, body, |chunk| {
        for line in lines.push(chunk) {
            if line.len() <= MAX_REPLY_LINE_BYTES {
                on_line(&line);
            }
        }
    });
    headers.iter_mut().for_each(|header| wipe_string(header));
    // Timings and statuses only: never what was asked or said.
    eprintln!(
        "[screen] circle {path}: {:?} in {} ms",
        result.as_ref().ok(),
        started.elapsed().as_millis()
    );
    result.map_err(|_| ())
}

/// POSTs `body` and keeps the whole (small) reply.
fn post_whole<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    body: &[u8],
    reply: &mut Vec<u8>,
) -> Result<u16, ()> {
    post(app, path, body, |line| {
        if reply.len() + line.len() <= 16 * 1024 {
            reply.extend_from_slice(line.as_bytes());
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: ScreenRect = ScreenRect {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
    };

    fn mark(region: ScreenRect) -> MarkView {
        MarkView {
            number: 1,
            kind: marks::MarkKind::Circle,
            points: vec![
                (region.left as f32, region.top as f32),
                (region.right as f32, region.bottom as f32),
            ],
            targets: Vec::new(),
            region,
        }
    }

    #[test]
    fn crops_around_the_marks_with_some_context() {
        let region = ScreenRect {
            left: 400,
            top: 300,
            right: 800,
            bottom: 500,
        };
        let focus = focus_rect(&[mark(region)], MONITOR, 1.0).unwrap();
        assert_eq!(
            focus,
            ScreenRect {
                left: 340,
                top: 270,
                right: 860,
                bottom: 530
            }
        );
        // A tap: at least 96 CSS px, centred on it; kept on the capture.
        let tap = ScreenRect {
            left: 5,
            top: 5,
            right: 6,
            bottom: 6,
        };
        let small = focus_rect(&[mark(tap)], MONITOR, 1.5).unwrap();
        assert_eq!((small.left, small.top), (0, 0));
        assert!(small.right >= 70 && small.bottom >= 70);
    }

    #[test]
    fn maps_screen_areas_onto_the_focus_image() {
        let focus = ScreenRect {
            left: 100,
            top: 100,
            right: 300,
            bottom: 200,
        };
        let inner = ScreenRect {
            left: 150,
            top: 125,
            right: 250,
            bottom: 175,
        };
        assert_eq!(
            to_box(inner, focus),
            Box2 {
                left: 250,
                top: 250,
                right: 750,
                bottom: 750
            }
        );
    }

    #[test]
    fn puts_the_card_beside_the_marks_on_the_monitor() {
        let marks = ScreenRect {
            left: 200,
            top: 300,
            right: 600,
            bottom: 500,
        };
        let right = card_spot(marks, MONITOR, 1.0);
        assert_eq!((right.left, right.top), (612, 300));
        // No room on either side: below.
        let wide = ScreenRect {
            left: 100,
            top: 300,
            right: 1800,
            bottom: 500,
        };
        let below = card_spot(wide, MONITOR, 1.0);
        assert_eq!(below.top, 512);
        assert!(below.right <= MONITOR.right && below.left >= MONITOR.left);
    }
}
