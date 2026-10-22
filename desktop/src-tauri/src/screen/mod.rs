//! Screen Coach: an on-screen tutor for Windows (docs/SCREEN_COACH.md).
//!
//! Built so far:
//! - S0, plumbing: settings kept on this computer, the hold-to-talk and pause hotkeys, one
//!   in-memory capture per request, the capture indicator, tray states, and the local settings
//!   page with the opt-in.
//! - S1, privacy: blocked apps, password fields, private windows, calls, microphone access,
//!   blacking out blocked windows in monitor captures, and on-device redaction (`privacy/`,
//!   run in order by `pipeline.rs`).
//!
//! Where to start reading: `coach.rs` (what happens when a hotkey is pressed), then
//! `pipeline.rs` (one capture, step by step).

pub mod config;
pub mod frame;
pub mod image;
pub mod privacy;
pub mod secret;
pub mod tray_badge;

#[cfg(windows)]
pub mod coach;
#[cfg(windows)]
pub mod pipeline;
#[cfg(windows)]
pub mod win;

use tauri::Url;

/// True for the app's own bundled pages (served by Tauri on Windows from `http://tauri.localhost`).
pub fn is_local_page(url: &Url) -> bool {
    match (url.scheme(), url.host_str()) {
        ("http" | "https", Some("tauri.localhost")) => url.port().is_none(),
        ("tauri", Some("localhost")) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bundled_pages_are_local() {
        let local = |s: &str| is_local_page(&Url::parse(s).unwrap());
        assert!(local("http://tauri.localhost/screen-coach.html"));
        assert!(local("https://tauri.localhost/screen-coach.html"));
        assert!(local("tauri://localhost/screen-coach.html"));
        assert!(!local("http://localhost:3000/notebook"));
        assert!(!local("https://mew.example.com/screen-coach.html"));
        assert!(!local("http://tauri.localhost.evil.example/"));
        assert!(!local("http://tauri.localhost:8080/"));
        assert!(!local("file:///C:/screen-coach.html"));
    }
}
