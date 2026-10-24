//! Saving part of the screen to the notebook (S3 §3): all in Rust until the student confirms.
//!
//! 1. A draft is made from the live ink's screenshot ("save this", Ctrl+Alt+C, the pill), or
//!    from a new capture: the ink re-placed first, or with no ink, the monitor to drag a region
//!    out of. Its source (app, window title, a trimmed link) is read now, on the device.
//! 2. The local preview window shows it. Its page fetches the image from `mewclip://` (served
//!    from memory, to that window only, while the draft lives) and gets the ink as vectors.
//! 3. Save: the crop is checked (a protected video captures black), encoded, its visible text
//!    read, and uploaded with the device token. The web page gets only the new clip's id.
//!    Cancel, or a minute without an answer: everything is wiped, nothing was sent.
//!
//! A Circle & Ask explanation (S3.2, decision 11) is saved the same way as an **entry**: a clip
//! with the student's marks and the explanation attached. It's saved straight away once its toast
//! ends (`save_entry`), or through the preview ("Edit crop", `open_entry`).

use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, Url, WebviewWindow};

use super::account::{forget_revoked_token, wipe_string};
use super::annotate::{self, InkTurn, TurnState};
use super::coach::{self, ScreenCoach};
use super::config::CaptureScope;
use super::frame::{FrameDetail, FrameMeta};
use super::image::{crop, downscale_bgra_to_bgr, looks_blank};
use super::ink::{
    clip_strokes, clip_strokes_kept, default_crop, overlay_to_frame, InkStroke, InkTool, Rect,
};
use super::overlay::{self, Surface};
use super::page;
use super::pipeline::{self, Captured, ScreenError};
use super::protocol::{
    clip_body, parse_clip_created, ClipHead, ClipSource, EntryHead, EntryTurnOut,
};
use super::secret::SecretBytes;
use super::source::{
    clean_title, is_browser, is_video_page, player_time, sanitize_url, with_timestamp,
};
use super::win::encode::{encode_jpeg_with, JpegOptions, FOR_CLIP};
use super::win::{credential, crypto, http, target};

/// The custom protocol the preview loads the image from (served as http://mewclip.localhost/).
pub const SCHEME: &str = "mewclip";
/// A preview nobody answers is discarded after this (brief §3.2).
const DECISION_TIME: Duration = Duration::from_secs(60);
/// Longest side of a saved clip (brief §3.2).
const CLIP_LONG_SIDE: u32 = 2400;
/// Longest side of the image the preview shows.
const PREVIEW_LONG_SIDE: u32 = 1600;
const PREVIEW_JPEG: JpegOptions = JpegOptions {
    quality: 0.85,
    full_chroma: true,
};
const OCR_TEXT_CHARS: usize = 8_000;

/// Preview page events (desktop/overlay-src/clip-preview.ts).
const OPEN: &str = "mew:clip-open";
const RESET: &str = "mew:clip-reset";

/// A clip waiting for the student's decision. Everything here is wiped when it's dropped.
pub struct ClipDraft {
    id: u64,
    nonce: String,
    created: Instant,
    meta: FrameMeta,
    detail: FrameDetail,
    preview: SecretBytes,
    strokes: Vec<InkStroke>,
    cards: Vec<Rect>,
    /// The default crop, in frame pixels; None to drag one out (no ink).
    crop: Option<Rect>,
    source: DraftSource,
    /// Circle & Ask: what makes it an entry.
    entry: Option<EntryDraft>,
}

/// A Circle & Ask explanation to save with its picture (S3.2 §5). Strokes are in overlay pixels,
/// like the tutor's.
pub struct EntryDraft {
    pub session_id: String,
    pub student_strokes: Vec<InkStroke>,
    pub turn: EntryTurnOut,
    /// The explanation step of each of the draft's tutor strokes.
    pub stroke_steps: Vec<u8>,
    pub concept_hints: Vec<String>,
}

/// What an entry is drawn and saved from: the capture and everything on it.
pub struct EntryCapture {
    pub meta: FrameMeta,
    pub detail: FrameDetail,
    /// The tutor's strokes, in overlay pixels.
    pub strokes: Vec<InkStroke>,
    /// The crop, in frame pixels.
    pub crop: Rect,
    pub entry: EntryDraft,
}

struct DraftSource {
    app: String,
    title: Option<String>,
    url: Option<Url>,
    timestamp: Option<u32>,
}

/// What the preview page shows (no pixels: the image comes from `mewclip://`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInfo {
    image_url: String,
    /// The capture's size in frame pixels (crops and strokes are in these).
    frame: [f32; 2],
    crop: Option<Rect>,
    strokes: Vec<PreviewStroke>,
    cards: Vec<Rect>,
    source: PreviewSource,
    expires_in_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewStroke {
    tool: &'static str,
    color: String,
    width: f32,
    points: Vec<[f32; 4]>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSource {
    app: String,
    title: Option<String>,
    /// The link that would be saved (already trimmed), with the video's moment.
    link: Option<String>,
    /// Links are on by default for web pages and videos (brief §3.2).
    include_link: bool,
}

// ─── Starting a clip ─────────────────────────────────────────────────────────────────────────

/// "Save this" with the ink on screen (the pill, the hotkey, or by voice): clip the screenshot
/// the ink was drawn on. Without live ink, start from a new capture instead.
pub fn from_ink<R: Runtime>(app: &AppHandle<R>) {
    match annotate::turn_state(app) {
        TurnState::Live => {
            let Some(turn) = annotate::take_for_clip(app) else {
                return;
            };
            let handle = app.clone();
            coach::on_worker(app, move |tools| {
                let privacy = coach::privacy_of(&handle);
                // Only if looking would be allowed right now (a password field, a blocked app).
                if let Err(error) = pipeline::may_use_screen_now(tools, &privacy) {
                    coach::notify(&handle, &error.message());
                    return;
                }
                match draft_from_turn(tools, turn) {
                    Some(draft) => open(&handle, draft),
                    None => coach::notify(&handle, "I couldn't prepare that clip. Try again."),
                }
            });
        }
        TurnState::Stale => coach::capture_for_clip(app, CaptureScope::Window, Purpose::Reannotate),
        TurnState::None => coach::capture_for_clip(app, CaptureScope::Monitor, Purpose::Select),
    }
}

/// The clip hotkey (Ctrl+Alt+C).
pub fn on_hotkey<R: Runtime>(app: &AppHandle<R>) {
    from_ink(app);
}

/// "Save this" said while holding the talk hotkey: its capture is either not needed (live ink),
/// used to re-place the ink, or the picture to drag a region out of.
pub fn from_voice<R: Runtime>(app: &AppHandle<R>, captured: Captured) {
    match annotate::turn_state(app) {
        TurnState::Live => {
            drop(captured);
            from_ink(app);
        }
        TurnState::Stale => annotate::reannotate(app, captured, true),
        TurnState::None => on_captured(app, Purpose::Select, captured),
    }
}

/// What a capture made for a clip is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    /// Re-place the earlier ink on it, then clip.
    Reannotate,
    /// No ink: drag a region out of it.
    Select,
}

/// A capture made for a clip arrived (on the capture worker thread).
pub fn on_captured<R: Runtime>(app: &AppHandle<R>, purpose: Purpose, captured: Captured) {
    match purpose {
        Purpose::Reannotate => {
            let handle = app.clone();
            // Off the worker: re-placing may ask the server.
            let _ = std::thread::Builder::new()
                .name("mew-clip-reannotate".into())
                .spawn(move || annotate::reannotate(&handle, captured, true));
        }
        Purpose::Select => {
            let handle = app.clone();
            coach::on_worker(app, move |tools| {
                match draft_for_selection(tools, captured) {
                    Some(draft) => open(&handle, draft),
                    None => coach::notify(&handle, "I couldn't prepare that clip. Try again."),
                }
            });
        }
    }
}

/// Saves an explanation as an entry now (its toast ended, or Open was pressed), without the
/// preview. Runs on the capture worker (WIC and UI Automation). With `open`, the notebook comes
/// forward at the entry; otherwise the page adds it quietly.
pub fn save_entry<R: Runtime>(
    app: &AppHandle<R>,
    tools: &mut pipeline::Tools,
    capture: EntryCapture,
    include_link: bool,
    open: bool,
) -> Result<Saved, String> {
    let crop = capture.crop;
    let draft = entry_draft(tools, capture).ok_or("I couldn't prepare that for your notebook.")?;
    save(app, draft, crop, Saving::Entry { include_link, open })
}

/// "Edit crop": the explanation in the preview, to save with a different crop (or not at all).
pub fn open_entry<R: Runtime>(
    app: &AppHandle<R>,
    tools: &mut pipeline::Tools,
    capture: EntryCapture,
) {
    match entry_draft(tools, capture) {
        Some(draft) => open(app, draft),
        None => coach::notify(app, "I couldn't open the preview."),
    }
}

fn entry_draft(tools: &mut pipeline::Tools, capture: EntryCapture) -> Option<ClipDraft> {
    let EntryCapture {
        meta,
        detail,
        strokes,
        crop,
        entry,
    } = capture;
    let source = read_source(tools, &meta, None, &detail);
    let mut draft = draft(meta, detail, strokes, Vec::new(), Some(crop), source)?;
    draft.entry = Some(entry);
    Some(draft)
}

fn draft_from_turn(tools: &mut pipeline::Tools, mut turn: InkTurn) -> Option<ClipDraft> {
    let detail = turn.frame.take()?;
    let drawn = turn.drawn.take()?;
    let (dx, dy) = overlay_to_frame(&turn.meta);
    let crop = drawn.bbox.and_then(|bbox| default_crop(bbox, &turn.meta));
    let cards = drawn
        .cards
        .iter()
        .map(|[x, y, w, h]| [x + dx, y + dy, *w, *h])
        .collect();
    let source = read_source(tools, &turn.meta, turn.video_time_sec, &detail);
    draft(
        turn.meta.clone(),
        detail,
        drawn.strokes,
        cards,
        crop,
        source,
    )
}

fn draft_for_selection(tools: &mut pipeline::Tools, captured: Captured) -> Option<ClipDraft> {
    let Captured { meta, detail, .. } = captured;
    let source = read_source(tools, &meta, None, &detail);
    draft(meta, detail, Vec::new(), Vec::new(), None, source)
}

fn draft(
    meta: FrameMeta,
    detail: FrameDetail,
    strokes: Vec<InkStroke>,
    cards: Vec<Rect>,
    crop: Option<Rect>,
    source: DraftSource,
) -> Option<ClipDraft> {
    let small = downscale_bgra_to_bgr(&detail.pixels, PREVIEW_LONG_SIDE);
    let preview = encode_jpeg_with(&small, PREVIEW_JPEG).ok()?;
    drop(small);
    let nonce: String = crypto::random_bytes::<16>()
        .ok()?
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Some(ClipDraft {
        id: 0,
        nonce,
        created: Instant::now(),
        meta,
        detail,
        preview,
        strokes,
        cards,
        crop,
        source,
        entry: None,
    })
}

/// Where the clip came from, read now: the window title, the browser's address (trimmed), and a
/// video's moment (the media session, else the player's time display, else the tutor's reading).
fn read_source(
    tools: &mut pipeline::Tools,
    meta: &FrameMeta,
    video_time_sec: Option<u32>,
    detail: &FrameDetail,
) -> DraftSource {
    let app = meta.app.clone().unwrap_or_else(|| "unknown.exe".to_owned());
    let window = meta
        .window
        .map(|raw| windows::Win32::Foundation::HWND(raw as *mut _));
    let title = window
        .map(target::window_title)
        .and_then(|raw| clean_title(&raw, &app));
    let url = match window {
        Some(window) if is_browser(&app) => {
            tools.address_bar(window).and_then(|raw| sanitize_url(&raw))
        }
        _ => None,
    };
    let timestamp = url.as_ref().filter(|u| is_video_page(u)).and_then(|_| {
        tools
            .media_state(&app)
            .and_then(|state| state.position_sec)
            .or_else(|| {
                let rules = super::privacy::detect::RedactionRules::default();
                player_time(&detail.text.text_in(meta.bounds, &rules))
            })
            .or(video_time_sec)
    });
    DraftSource {
        app,
        title,
        url,
        timestamp,
    }
}

/// Where a notes check's material came from (for its link chips): the same reading as a
/// clip's, as the link with its moment, the title and the time.
pub fn notes_source(
    tools: &mut pipeline::Tools,
    meta: &FrameMeta,
    detail: &FrameDetail,
) -> super::notes_marks::NotesSource {
    let source = read_source(tools, meta, None, detail);
    let url = source.url.as_ref().map(|url| match source.timestamp {
        Some(seconds) => with_timestamp(url, seconds).to_string(),
        None => url.to_string(),
    });
    super::notes_marks::NotesSource {
        title: url.as_ref().and(source.title.clone()),
        timestamp_sec: url.as_ref().and(source.timestamp),
        url,
    }
}

/// Holds the draft and shows the preview (replacing any earlier draft, which is wiped).
fn open<R: Runtime>(app: &AppHandle<R>, mut draft: ClipDraft) {
    let Some(coach) = app.try_state::<ScreenCoach>() else {
        return;
    };
    let Some(window) = overlay::ensure(app, Surface::Clip) else {
        coach::notify(app, "I couldn't open the clip preview.");
        return;
    };
    let id = {
        let mut slot = coach.clip();
        let id = slot.as_ref().map_or(0, |d| d.id) + 1;
        draft.id = id;
        *slot = Some(draft);
        id
    };
    overlay::dispatch(app, Surface::Clip, OPEN, &json!({}));
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    let handle = app.clone();
    let _ = std::thread::Builder::new()
        .name("mew-clip-timeout".into())
        .spawn(move || {
            std::thread::sleep(DECISION_TIME);
            discard(&handle, Some(id));
        });
}

/// Wipes the draft (`only` this one, if given) and hides the preview.
pub fn discard<R: Runtime>(app: &AppHandle<R>, only: Option<u64>) {
    let Some(coach) = app.try_state::<ScreenCoach>() else {
        return;
    };
    let dropped = {
        let mut slot = coach.clip();
        match (&*slot, only) {
            (Some(draft), Some(id)) if draft.id != id => None,
            _ => slot.take(),
        }
    };
    if dropped.is_some() || only.is_none() {
        close_preview(app);
    }
    drop(dropped);
}

fn close_preview<R: Runtime>(app: &AppHandle<R>) {
    overlay::dispatch(app, Surface::Clip, RESET, &json!({}));
    if let Some(window) = app.get_webview_window(Surface::Clip.label()) {
        let _ = window.hide();
    }
}

// ─── The preview's image ────────────────────────────────────────────────────────────────────

/// Serves the draft's preview image to the preview window only, at its one-time path, from
/// memory. Everything else gets 404 (no hint whether a draft exists).
pub fn serve<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let not_found = || {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("Cache-Control", "no-store")
            .body(Vec::new())
            .unwrap_or_default()
    };
    if ctx.webview_label() != Surface::Clip.label() || request.method() != "GET" {
        return not_found();
    }
    let Some(coach) = ctx.app_handle().try_state::<ScreenCoach>() else {
        return not_found();
    };
    let slot = coach.clip();
    let Some(draft) = slot
        .as_ref()
        .filter(|d| d.created.elapsed() < DECISION_TIME)
    else {
        return not_found();
    };
    if request.uri().path() != format!("/{}/frame.jpg", draft.nonce) {
        return not_found();
    }
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "image/jpeg")
        // Never cached: WebView2 must not write it to its disk cache.
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(draft.preview.as_slice().to_vec())
        .unwrap_or_else(|_| not_found())
}

// ─── Commands for the preview page ──────────────────────────────────────────────────────────

/// What the preview shows, for the draft waiting now.
#[tauri::command(async)]
pub fn screen_clip_ready<R: Runtime>(window: WebviewWindow<R>) -> Result<PreviewInfo, String> {
    overlay::require_surface(&window, Surface::Clip)?;
    let coach = coach::coach_of(window.app_handle())?;
    let slot = coach.clip();
    let draft = slot.as_ref().ok_or("This preview has expired.")?;
    let (dx, dy) = overlay_to_frame(&draft.meta);
    let link = draft
        .source
        .url
        .as_ref()
        .map(|url| match draft.source.timestamp {
            Some(seconds) => with_timestamp(url, seconds).to_string(),
            None => url.to_string(),
        });
    Ok(PreviewInfo {
        image_url: format!("http://{SCHEME}.localhost/{}/frame.jpg", draft.nonce),
        frame: [
            draft.meta.bounds.width() as f32,
            draft.meta.bounds.height() as f32,
        ],
        crop: draft.crop,
        strokes: draft
            .strokes
            .iter()
            .chain(draft.entry.iter().flat_map(|e| e.student_strokes.iter()))
            .map(|s| PreviewStroke {
                tool: tool_name(s.tool),
                color: s.color.clone(),
                width: s.width,
                points: s
                    .points
                    .iter()
                    .map(|[x, y, p, t]| [x + dx, y + dy, *p, *t])
                    .collect(),
            })
            .collect(),
        cards: draft.cards.clone(),
        source: PreviewSource {
            app: draft.source.app.clone(),
            title: draft.source.title.clone(),
            include_link: link.is_some(),
            link,
        },
        expires_in_ms: DECISION_TIME
            .saturating_sub(draft.created.elapsed())
            .as_millis() as u64,
    })
}

/// The student pressed Save: crop, encode and upload the clip; the main page then opens it.
#[tauri::command(async)]
pub fn screen_clip_save<R: Runtime>(
    window: WebviewWindow<R>,
    crop: Rect,
    include_notes: bool,
    include_link: bool,
) -> Result<(), String> {
    overlay::require_surface(&window, Surface::Clip)?;
    let app = window.app_handle().clone();
    let draft = coach::coach_of(&app)?
        .clip()
        .take()
        .ok_or("This preview has expired.")?;
    close_preview(&app);
    let (done, result) = mpsc::channel();
    let handle = app.clone();
    let saving = if draft.entry.is_some() {
        Saving::Entry {
            include_link,
            open: true,
        }
    } else {
        Saving::Clip {
            include_notes,
            include_link,
        }
    };
    let queued = coach::on_worker(&app, move |_tools| {
        let _ = done.send(save(&handle, draft, crop, saving).map(|_| ()));
    });
    if !queued {
        return Err("Couldn't save the clip just now.".to_owned());
    }
    let outcome = result
        .recv_timeout(Duration::from_secs(30))
        .unwrap_or_else(|_| Err("Saving took too long. Try again.".to_owned()));
    if let Err(message) = &outcome {
        coach::notify(&app, message);
    }
    outcome
}

#[tauri::command(async)]
pub fn screen_clip_cancel<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    overlay::require_surface(&window, Surface::Clip)?;
    discard(window.app_handle(), None);
    Ok(())
}

/// What is being saved: a clip from the preview (the main window opens it), or a Circle & Ask
/// entry (the notebook adds it quietly, unless `open`).
#[derive(Debug, Clone, Copy)]
enum Saving {
    Clip {
        include_notes: bool,
        include_link: bool,
    },
    Entry {
        include_link: bool,
        open: bool,
    },
}

/// A saved clip: its id, and how its image was cut (crop in frame pixels; image pixels per
/// frame pixel), so later strokes can be placed on it the same way.
pub struct Saved {
    pub clip_id: String,
    pub crop: Rect,
    pub scale: f32,
}

/// Crops, encodes and uploads (on the capture worker: WIC needs its COM apartment).
fn save<R: Runtime>(
    app: &AppHandle<R>,
    mut draft: ClipDraft,
    crop_rect: Rect,
    saving: Saving,
) -> Result<Saved, String> {
    let (include_notes, include_link) = match saving {
        Saving::Clip {
            include_notes,
            include_link,
        } => (include_notes, include_link),
        Saving::Entry { include_link, .. } => (true, include_link),
    };
    let meta = &draft.meta;
    let frame = [
        0.0,
        0.0,
        meta.bounds.width() as f32,
        meta.bounds.height() as f32,
    ];
    let crop_rect = super::ink::clamp_rect(crop_rect, frame)
        .filter(|r| r.iter().all(|v| v.is_finite()))
        .ok_or("Choose a bigger area to save.")?;

    // Frame pixels → captured pixels (the capture may differ slightly from the window's size).
    let pixels = &draft.detail.pixels;
    let sx = pixels.width as f32 / meta.bounds.width().max(1) as f32;
    let sy = pixels.height as f32 / meta.bounds.height().max(1) as f32;
    let raw = crop(
        pixels,
        (crop_rect[0] * sx) as u32,
        (crop_rect[1] * sy) as u32,
        ((crop_rect[0] + crop_rect[2]) * sx).ceil() as u32,
        ((crop_rect[1] + crop_rect[3]) * sy).ceil() as u32,
    );
    if raw.width < 8 || raw.height < 8 {
        return Err("Choose a bigger area to save.".to_owned());
    }
    if looks_blank(&raw) {
        return Err(
            "This video can't be captured (it's protected), so I didn't save it.".to_owned(),
        );
    }
    let small = downscale_bgra_to_bgr(&raw, CLIP_LONG_SIDE);
    drop(raw);
    let (width, height) = (small.width, small.height);
    let jpeg = encode_jpeg_with(&small, FOR_CLIP).map_err(|_| ScreenError::Failed.message())?;
    drop(small);

    // Clip image pixels per frame pixel, and per CSS pixel of the screen it came from.
    let scale = width as f32 / crop_rect[2];
    let pixel_ratio = scale * meta.dpi.max(96) as f32 / 96.0;
    let kept = if include_notes {
        clip_strokes_kept(&draft.strokes, meta, crop_rect, scale)
    } else {
        Vec::new()
    };
    let entry = draft.entry.take().map(|entry| EntryHead {
        session_id: entry.session_id,
        student_strokes: clip_strokes(&entry.student_strokes, meta, crop_rect, scale),
        turn: entry.turn,
        stroke_steps: kept
            .iter()
            .map(|(i, _)| entry.stroke_steps.get(*i).copied().unwrap_or(0))
            .collect(),
        concept_hints: entry.concept_hints,
    });
    let strokes = kept.into_iter().map(|(_, stroke)| stroke).collect();
    let rules = coach::privacy_of(app).redaction;
    let on_screen = super::frame::ScreenRect {
        left: meta.bounds.left + crop_rect[0] as i32,
        top: meta.bounds.top + crop_rect[1] as i32,
        right: meta.bounds.left + (crop_rect[0] + crop_rect[2]) as i32,
        bottom: meta.bounds.top + (crop_rect[1] + crop_rect[3]) as i32,
    };
    let mut ocr_text: String = draft
        .detail
        .text
        .text_in(on_screen, &rules)
        .chars()
        .take(OCR_TEXT_CHARS)
        .collect();
    let url = draft
        .source
        .url
        .as_ref()
        .filter(|_| include_link)
        .map(|url| match draft.source.timestamp {
            Some(seconds) => with_timestamp(url, seconds).to_string(),
            None => url.to_string(),
        });
    let head = ClipHead {
        pixel_ratio,
        strokes,
        source: ClipSource {
            app: draft.source.app.clone(),
            title: draft.source.title.clone(),
            timestamp_sec: url.as_ref().and(draft.source.timestamp),
            url,
            captured_at: rfc3339(SystemTime::now()),
        },
        ocr_text: ocr_text.clone(),
        entry,
    };
    wipe_string(&mut ocr_text);
    let body = clip_body(&head, jpeg.as_slice(), width, height);
    drop(head);
    drop(jpeg);
    drop(draft);

    let clip_id = upload(app, &body)?;
    drop(body);
    match saving {
        Saving::Clip { .. } => {
            page::dispatch(app, page::CLIP_SAVED, json!({ "clipId": clip_id }));
            show_notebook(app);
        }
        // An entry is added to the notebook quietly, unless asked: the student is in their app.
        Saving::Entry { open, .. } => {
            page::dispatch(
                app,
                page::ENTRY_SAVED,
                json!({ "clipId": clip_id, "open": open }),
            );
            if open {
                show_notebook(app);
            }
        }
    }
    eprintln!("[screen] clip saved ({width}x{height})");
    Ok(Saved {
        clip_id,
        crop: crop_rect,
        scale,
    })
}

/// Brings the main window (the notebook) forward.
pub fn show_notebook<R: Runtime>(app: &AppHandle<R>) {
    if let Some(main) = app.get_webview_window(crate::MAIN) {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

fn upload<R: Runtime>(app: &AppHandle<R>, body: &SecretBytes) -> Result<String, String> {
    let coach = coach::coach_of(app)?;
    let token = credential::load().ok_or(
        "Connect Screen Coach to your Mew account first: tray → Screen Coach settings → Connect.",
    )?;
    let token = std::str::from_utf8(token.as_slice())
        .map_err(|_| "Connect Screen Coach again in its settings.")?;
    let url = coach
        .app_url()
        .join("api/screen/clips")
        .map_err(|_| "The Mew address is invalid.")?;
    let mut headers = [
        "Content-Type: application/json".to_owned(),
        format!("Authorization: Bearer {token}"),
    ];
    let mut reply = Vec::with_capacity(1024);
    let status = http::post(&url, &headers, body.as_slice(), |chunk| {
        if reply.len() < 4096 {
            reply.extend_from_slice(chunk)
        }
    });
    headers.iter_mut().for_each(|header| wipe_string(header));
    match status.map_err(|_| "I couldn't reach Mew to save the clip. Check your connection.")? {
        200 | 201 => {
            parse_clip_created(&reply).ok_or_else(|| "Mew sent an unexpected reply.".to_owned())
        }
        401 => {
            forget_revoked_token(app);
            Err("Screen Coach was signed out of your Mew account. Connect again in Screen Coach settings.".to_owned())
        }
        413 => Err("That area is too big to save. Choose a smaller one.".to_owned()),
        429 => Err("You've saved a lot of clips recently. Try again in a little while.".to_owned()),
        _ => Err("Mew couldn't save the clip just now. Try again in a moment.".to_owned()),
    }
}

fn tool_name(tool: InkTool) -> &'static str {
    match tool {
        InkTool::Pen => "pen",
        InkTool::Highlighter => "highlighter",
    }
}

/// "2026-10-22T10:00:00Z" (UTC, whole seconds).
pub fn rfc3339(time: SystemTime) -> String {
    let secs = time.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's days-to-civil algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::image::fit_within;

    #[test]
    fn writes_utc_timestamps() {
        let at = |secs: u64| rfc3339(UNIX_EPOCH + Duration::from_secs(secs));
        assert_eq!(at(0), "1970-01-01T00:00:00Z");
        assert_eq!(at(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(at(1_792_663_200), "2026-10-22T10:00:00Z");
        assert_eq!(at(4_102_444_799), "2099-12-31T23:59:59Z");
    }

    #[test]
    fn previews_fit_and_clips_are_capped() {
        assert_eq!(fit_within(3840, 2160, CLIP_LONG_SIDE), (2400, 1350));
        assert_eq!(fit_within(1200, 600, CLIP_LONG_SIDE), (1200, 600));
    }
}
