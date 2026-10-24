//! "Check my notes" on the desktop (Notes Check N4, docs/SCREEN_COACH_NOTES_CHECK.md §2–3, §8).
//!
//! 1. A capture (the hotkey, or "check my notes" said over the talk hotkey) runs the usual
//!    privacy pipeline. Only the text left after redaction is used, as blocks (`screen_text`):
//!    the picture is wiped without being sent, and the blocks' positions stay here.
//! 2. The blocks go to the web app's server with the device token; it compares them with the
//!    student's notes and answers with findings (checked by `notes_marks::parse_notes_reply`).
//! 3. The summary is spoken by the page; the findings go to the page for its notebook marks; the
//!    screen gets its own marks (`notes_marks::notes_marks`, drawn by the ink overlay, so they
//!    fade when the content moves and "show that again" re-places them); and the Notes Check
//!    panel lists the findings beside the screen.

use std::time::Instant;

use serde_json::json;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use super::account::{forget_revoked_token, wipe_string};
use super::annotate::{self, ShowInk};
use super::coach::{self, ScreenCoach};
use super::frame::{FrameMeta, ScreenRect};
use super::notes_marks::{notes_check_body, notes_marks, parse_notes_reply, NotesSource};
use super::overlay::{self, require_surface, Surface};
use super::page;
use super::pipeline::Captured;
use super::win::{credential, http};

/// Panel page events (desktop/overlay-src/notes-panel.ts).
const PANEL_SHOW: &str = "mew:notes-panel-show";
/// A reply larger than this is refused (24 findings of a few hundred characters each).
const MAX_REPLY_BYTES: usize = 256 * 1024;
/// The panel's size, in CSS pixels.
const PANEL_SIZE: (f64, f64) = (380.0, 520.0);

/// Starts a check of `captured`: reads where it came from on the capture worker (which can ask
/// the browser for its address), then compares it on its own thread.
pub fn start<R: Runtime>(app: &AppHandle<R>, captured: Captured, all_notes: bool) {
    let handle = app.clone();
    let queued = coach::on_worker(app, move |tools| {
        let source = super::clip::notes_source(tools, &captured.meta, &captured.detail);
        run_in_background(&handle, captured, source, all_notes);
    });
    if !queued {
        coach::notify(app, "Couldn't check your notes just now.");
    }
}

/// Compares a capture with the notes, on its own thread (the network call takes seconds).
/// `source` says where the material came from (read on the capture worker, which can ask the
/// browser for its address).
pub fn run_in_background<R: Runtime>(
    app: &AppHandle<R>,
    captured: Captured,
    source: NotesSource,
    all_notes: bool,
) {
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("mew-notes-check".into())
        .spawn(move || {
            if let Err(message) = check(&handle, captured, &source, all_notes) {
                coach::notify(&handle, &message);
            }
            coach::settle(&handle);
        });
    if spawned.is_err() {
        coach::notify(app, "Couldn't check your notes just now.");
    }
}

fn check<R: Runtime>(
    app: &AppHandle<R>,
    captured: Captured,
    source: &NotesSource,
    all_notes: bool,
) -> Result<(), String> {
    let coach = app
        .try_state::<ScreenCoach>()
        .ok_or("Screen Coach isn't ready.")?;
    let Captured { jpeg, meta, detail } = captured;
    drop(jpeg); // only the text is compared: the picture is wiped unsent

    let blocks = detail.text.blocks(&coach.privacy().redaction);
    if blocks.is_empty() {
        return Err("I couldn't read any text on your screen to compare with your notes.".into());
    }
    let token = credential::load().ok_or(
        "Connect Screen Coach to your Mew account first: tray → Screen Coach settings → Connect.",
    )?;
    let token = std::str::from_utf8(token.as_slice())
        .map_err(|_| "Connect Screen Coach again in its settings.")?;
    let body = notes_check_body(&blocks, meta.app.as_deref(), all_notes, source);
    let url = coach
        .app_url()
        .join("api/screen/notes-check")
        .map_err(|_| "The Mew address is invalid.")?;
    let mut headers = [
        "Content-Type: application/json".to_owned(),
        "Accept: application/json".to_owned(),
        format!("Authorization: Bearer {token}"),
    ];

    let started = Instant::now();
    let mut reply = Vec::new();
    let mut too_large = false;
    let result = http::post(&url, &headers, body.as_slice(), |chunk| {
        if reply.len() + chunk.len() > MAX_REPLY_BYTES {
            too_large = true;
        } else {
            reply.extend_from_slice(chunk);
        }
    });
    headers.iter_mut().for_each(|header| wipe_string(header));
    drop(body);
    let status =
        result.map_err(|_| "I couldn't reach Mew. Check your connection and try again.")?;
    // Timings and counts only: never what was on screen or in the notes.
    eprintln!(
        "[screen] notes check: status {status}, {} blocks, in {} ms",
        blocks.len(),
        started.elapsed().as_millis()
    );
    match status {
        200 if !too_large => {}
        401 => {
            forget_revoked_token(app);
            return Err("Screen Coach was signed out of your Mew account. Connect again in Screen Coach settings.".into());
        }
        429 => return Err("You've checked your notes a lot today. Try again later.".into()),
        _ => return Err("I couldn't check your notes just now. Try again in a moment.".into()),
    }
    let reply = parse_notes_reply(&reply).ok_or("I couldn't check your notes just now.")?;

    page::dispatch(app, page::SPEECH, json!({ "text": reply.speech }));
    page::dispatch(app, page::NOTES_CHECKED, json!(reply));
    let marks = notes_marks(&reply.findings, &blocks, meta.bounds);
    drop(blocks);
    show_panel(app, &meta, &reply);
    if !marks.is_empty() {
        annotate::show(
            app,
            ShowInk {
                seed: reply.check_id.clone().unwrap_or_else(|| "notes".into()),
                actions: marks,
                meta,
                detail,
                video_time_sec: None,
                clip_when_drawn: false,
                coaching: false,
            },
        );
    }
    Ok(())
}

// ─── The panel ───────────────────────────────────────────────────────────────────────────────

/// Shows the findings in the Notes Check panel at the right of the capture's monitor, without
/// taking the focus from the student's app.
fn show_panel<R: Runtime>(
    app: &AppHandle<R>,
    meta: &FrameMeta,
    reply: &super::notes_marks::NotesCheckReply,
) {
    let Some(window) = overlay::ensure(app, Surface::Notes) else {
        return;
    };
    let scale = f64::from(meta.dpi.max(96)) / 96.0;
    overlay::place(&window, panel_spot(meta.monitor, scale));
    overlay::dispatch(app, Surface::Notes, PANEL_SHOW, &json!(reply));
    overlay::show_quietly(&window);
}

/// Top right of the monitor, below where title bars usually are (physical pixels).
fn panel_spot(monitor: ScreenRect, scale: f64) -> ScreenRect {
    let gap = (16.0 * scale).round() as i32;
    let w = (PANEL_SIZE.0 * scale).round() as i32;
    let h = ((PANEL_SIZE.1 * scale).round() as i32).min(monitor.height() - 2 * gap);
    let left = monitor.right - w - gap;
    let top = monitor.top + (72.0 * scale).round() as i32;
    ScreenRect {
        left,
        top,
        right: left + w,
        bottom: (top + h).min(monitor.bottom - gap),
    }
}

/// The panel's buttons: close it, hide the marks on screen, or open a finding's line in the
/// notebook.
#[tauri::command]
pub fn screen_notes_panel<R: Runtime>(
    window: WebviewWindow<R>,
    action: String,
    finding_id: Option<String>,
) -> Result<(), String> {
    require_surface(&window, Surface::Notes)?;
    let app = window.app_handle();
    match action.as_str() {
        "close" => overlay::hide_quietly(&window),
        "hide_marks" => annotate::clear(app),
        "open_line" => {
            let id = finding_id
                .filter(|id| super::protocol::is_uuid(id))
                .ok_or("Not allowed.")?;
            page::dispatch(app, page::NOTES_OPEN, json!({ "findingId": id }));
            if let Some(main) = app.get_webview_window(crate::MAIN) {
                let _ = main.show();
                let _ = main.unminimize();
                let _ = main.set_focus();
            }
        }
        _ => return Err("Not allowed.".to_owned()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn puts_the_panel_at_the_top_right_of_the_monitor() {
        let monitor = ScreenRect {
            left: -2880,
            top: 0,
            right: 0,
            bottom: 1620,
        };
        let spot = panel_spot(monitor, 1.5);
        assert_eq!(spot.right, -24);
        assert_eq!((spot.width(), spot.height()), (570, 780));
        assert!(spot.top >= monitor.top && spot.bottom <= monitor.bottom);
    }
}
