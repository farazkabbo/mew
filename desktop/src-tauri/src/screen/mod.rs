//! Screen Coach: an on-screen tutor for Windows (docs/SCREEN_COACH.md).
//!
//! Built so far:
//! - S0, plumbing: settings kept on this computer, the hold-to-talk and pause hotkeys, one
//!   in-memory capture per request, the capture indicator, tray states, and the local settings
//!   page with the opt-in.
//! - S1, privacy: blocked apps, password fields, private windows, calls, microphone access,
//!   blacking out blocked windows in monitor captures, and on-device redaction (`privacy/`,
//!   run in order by `pipeline.rs`).
//! - S2, asking: device sign-in (`account.rs`, decision 8), the question and its streamed answer
//!   (`ask.rs`, `protocol.rs`), passed to the web page to speak (`page.rs`).
//! - S3, ink and clips (docs/SCREEN_COACH_S3.md, decision 9): the answer's ink drawn beside the
//!   content (`annotate.rs`, `ink.rs`, `overlay.rs`), faded when it moves (`watch.rs`), re-placed
//!   on request (`reanchor.rs`), and saved to the notebook (`clip.rs`, `source.rs`). What was
//!   said over the hotkey is a question or a command (`intent.rs`).
//! - S3.5, Notes Check (docs/SCREEN_COACH_NOTES_CHECK.md): the screen's text compared with the
//!   student's notes, marks beside it and a panel of findings (`notes_check.rs`,
//!   `notes_marks.rs`).
//! - S4, coach mode (decision 10): a guided walkthrough, one step at a time, checked on the
//!   screen after each, with a progress pill (`coach_mode.rs`; the protocol, the words and the
//!   pill's view are pure, in `walkthrough.rs` and `intent.rs`). The walkthrough itself lives on
//!   the web app's server.
//! - S3.2, Circle & Ask (docs/SCREEN_COACH_S3_2.md, decision 11): a pointer beside the cursor;
//!   the student draws around something and asks; the tutor explains it step by step with ink, and
//!   it's saved to the notebook (`circle.rs`, `circle_answer.rs`; pure: `marks.rs`, `pointer.rs`,
//!   `circle_steps.rs`, `circle_protocol.rs`, `raster.rs`).
//!
//! - K3, save where I say (docs/NOTEBOOKS_K.md §4): the server resolves "save it to Physics chapter
//!   5" against the student's own notebooks; the card shows where an entry goes, offers chips, a
//!   picker and "Create it and save", and a saved entry moves when it's changed (`destination.rs`,
//!   pure; `circle_answer.rs`).
//! - K2, two-key shortcuts (docs/NOTEBOOKS_K.md §11): one global gesture, holding left Ctrl + left
//!   Alt to circle and talk (or double-tapping them for draw mode), read by polling (`keys.rs`,
//!   pure: `hold.rs`). Screen Coach registers no other global hotkey (Esc only while it shows
//!   something).
//!
//! Where to start reading: `coach.rs` (`on_hold`: what the gesture does), then
//! `pipeline.rs` (one capture, step by step), then `ask.rs` (asking about it), then
//! `annotate.rs` and `clip.rs`.

pub mod base64;
pub mod circle_protocol;
pub mod circle_steps;
pub mod config;
pub mod destination;
pub mod drag;
pub mod frame;
pub mod hold;
pub mod image;
pub mod ink;
pub mod intent;
pub mod marks;
pub mod notes_marks;
pub mod pointer;
pub mod privacy;
pub mod protocol;
pub mod raster;
pub mod screen_text;
pub mod secret;
pub mod source;
pub mod tray_badge;
pub mod walkthrough;
pub mod watch;

#[cfg(windows)]
pub mod account;
#[cfg(windows)]
pub mod annotate;
#[cfg(windows)]
pub mod ask;
#[cfg(windows)]
pub mod circle;
#[cfg(windows)]
pub mod circle_answer;
#[cfg(windows)]
pub mod clip;
#[cfg(windows)]
pub mod coach;
#[cfg(windows)]
pub mod coach_mode;
#[cfg(windows)]
pub mod keys;
#[cfg(windows)]
pub mod notes_check;
#[cfg(windows)]
pub mod overlay;
#[cfg(windows)]
pub mod page;
#[cfg(windows)]
pub mod pipeline;
#[cfg(windows)]
pub mod reanchor;
#[cfg(windows)]
pub mod win;

use tauri::Url;

/// True for the app's own bundled pages. Tauri serves them from `http://tauri.localhost`; under
/// `tauri dev` the CLI serves them from its built-in dev server instead (`dev_url`), which is
/// accepted only in debug builds and only at exactly that origin.
pub fn is_local_page(url: &Url, dev_url: Option<&Url>) -> bool {
    let bundled = match (url.scheme(), url.host_str()) {
        ("http" | "https", Some("tauri.localhost")) => url.port().is_none(),
        ("tauri", Some("localhost")) => true,
        _ => false,
    };
    let dev_server =
        cfg!(debug_assertions) && dev_url.is_some_and(|dev| dev.origin() == url.origin());
    bundled || dev_server
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bundled_pages_are_local() {
        let local = |s: &str| is_local_page(&Url::parse(s).unwrap(), None);
        assert!(local("http://tauri.localhost/screen-coach.html"));
        assert!(local("https://tauri.localhost/screen-coach.html"));
        assert!(local("tauri://localhost/screen-coach.html"));
        assert!(!local("http://localhost:3000/notebook"));
        assert!(!local("https://mew.example.com/screen-coach.html"));
        assert!(!local("http://tauri.localhost.evil.example/"));
        assert!(!local("http://tauri.localhost:8080/"));
        assert!(!local("file:///C:/screen-coach.html"));
    }

    #[test]
    fn the_dev_server_counts_only_in_debug_builds_and_only_at_its_origin() {
        let dev = Url::parse("http://localhost:1430").unwrap();
        let local = |s: &str| is_local_page(&Url::parse(s).unwrap(), Some(&dev));
        assert_eq!(
            local("http://localhost:1430/screen-coach.html"),
            cfg!(debug_assertions)
        );
        assert!(
            !local("http://localhost:3000/notebook"),
            "the web app is never local"
        );
        assert!(!local("http://localhost:1431/screen-coach.html"));
    }
}
