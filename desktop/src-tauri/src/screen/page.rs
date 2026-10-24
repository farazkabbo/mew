//! Talking to the web app's page in the main window: Screen Coach events go to it as DOM events
//! (the page needs no permission to receive them), and the two commands it may call are checked
//! to come from it.

use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, Url, WebviewWindow};

use crate::MAIN;

/// Events the page listens for (frontend/src/features/screen/events.ts).
pub const LISTEN: &str = "mew:screen-listen";
pub const RELEASE: &str = "mew:screen-release";
pub const CANCEL: &str = "mew:screen-cancel";
pub const SPEECH: &str = "mew:screen-speech";
pub const ANSWER: &str = "mew:screen-answer";
/// Coach mode (S4): a line to say now, cutting off anything older.
pub const SAY: &str = "mew:screen-say";
/// Stop whatever is being said (Circle & Ask: a step skipped, paused or stopped).
pub const HUSH: &str = "mew:screen-hush";
/// A clip was saved: the page builds its notebook page (S3).
pub const CLIP_SAVED: &str = "mew:screen-clip-saved";
/// A Circle & Ask entry was saved (S3.2): the page adds it to the notebook, and shows it if
/// `open`.
pub const ENTRY_SAVED: &str = "mew:screen-entry-saved";
/// A notes check's findings: the page marks the notebook lines (Notes Check).
pub const NOTES_CHECKED: &str = "mew:screen-notes-checked";
/// "Show in notebook" from the Notes Check panel: the page opens that finding's line.
pub const NOTES_OPEN: &str = "mew:screen-notes-open";

/// Dispatches `name` on the page with `detail`. Both are serialised as JSON, so whatever text
/// the server sent arrives as data, never as script.
pub fn dispatch<R: Runtime>(app: &AppHandle<R>, name: &str, detail: Value) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let (Ok(name), Ok(detail)) = (serde_json::to_string(name), serde_json::to_string(&detail))
    else {
        return;
    };
    let _ = window.eval(format!(
        "window.dispatchEvent(new CustomEvent({name}, {{ detail: {detail} }}))"
    ));
}

/// Commands for the web page must come from the main window showing the web app itself.
pub fn require_app_page<R: Runtime>(
    window: &WebviewWindow<R>,
    app_url: &Url,
) -> Result<(), String> {
    let on_app = window
        .url()
        .is_ok_and(|url| url.origin() == app_url.origin());
    if window.label() == MAIN && on_app {
        Ok(())
    } else {
        Err("Not allowed.".to_owned())
    }
}
