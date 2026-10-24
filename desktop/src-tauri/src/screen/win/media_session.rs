//! What Windows' media controls know about playing video (S3): whether the app in front is
//! playing (so the tutor can ask to pause first) and where it is (a saved clip's timestamp).
//!
//! Browsers publish their playing tab to the system media session (the same thing the volume
//! flyout shows). Only the playback state and position are read; titles stay unread.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Playback,
};
use windows_future::{AsyncStatus, IAsyncOperation};

/// Windows answers in a few milliseconds; a hung media service must never hold up a capture.
const TIMEOUT: Duration = Duration::from_millis(300);
/// 100-nanosecond ticks between 1601-01-01 (Windows' epoch) and 1970-01-01.
const EPOCH_DIFFERENCE_TICKS: i64 = 116_444_736_000_000_000;

/// The playing (or paused) media of one app, as Windows' media controls see it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MediaState {
    pub playing: bool,
    /// Seconds into the media, when the app reports a timeline.
    pub position_sec: Option<u32>,
}

/// The media session manager, created once per worker thread.
pub struct MediaSessions {
    manager: GlobalSystemMediaTransportControlsSessionManager,
}

impl MediaSessions {
    pub fn new() -> Option<Self> {
        let request = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().ok()?;
        Some(Self {
            manager: wait(&request)?,
        })
    }

    /// The media state of `app` (an executable name such as "msedge.exe"), if it has a session.
    pub fn state_of(&self, app: &str) -> Option<MediaState> {
        let stem = app.strip_suffix(".exe").unwrap_or(app);
        let sessions = self.manager.GetSessions().ok()?;
        let session = (0..sessions.Size().ok()?)
            .filter_map(|i| sessions.GetAt(i).ok())
            .find(|session| belongs_to(session, stem))?;
        let playing = session
            .GetPlaybackInfo()
            .and_then(|info| info.PlaybackStatus())
            .is_ok_and(|status| status == Playback::Playing);
        Some(MediaState {
            playing,
            position_sec: position(&session, playing),
        })
    }
}

/// Session ids are app ids like "MSEdge", "Chrome" or "msedge.exe": match the executable's stem.
fn belongs_to(session: &GlobalSystemMediaTransportControlsSession, stem: &str) -> bool {
    session
        .SourceAppUserModelId()
        .is_ok_and(|id| app_id_matches(&id.to_string_lossy(), stem))
}

pub fn app_id_matches(app_id: &str, stem: &str) -> bool {
    !stem.is_empty() && app_id.to_lowercase().contains(&stem.to_lowercase())
}

/// The current position: the reported one, plus the time since it was reported while playing.
fn position(session: &GlobalSystemMediaTransportControlsSession, playing: bool) -> Option<u32> {
    let timeline = session.GetTimelineProperties().ok()?;
    let reported = timeline.Position().ok()?.Duration;
    let updated = timeline.LastUpdatedTime().ok()?.UniversalTime;
    current_seconds(reported, updated, now_ticks()?, playing)
}

/// Seconds into the media from a position in 100 ns ticks reported at `updated` (Windows ticks).
pub fn current_seconds(reported: i64, updated: i64, now: i64, playing: bool) -> Option<u32> {
    if reported < 0 {
        return None;
    }
    let drift = if playing && updated > 0 {
        (now - updated).clamp(0, 6 * 3600 * 10_000_000)
    } else {
        0
    };
    u32::try_from((reported + drift) / 10_000_000).ok()
}

fn now_ticks() -> Option<i64> {
    let since_unix = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(since_unix.as_nanos() / 100)
        .ok()
        .map(|ticks| ticks + EPOCH_DIFFERENCE_TICKS)
}

/// Waits for an async operation, giving up after `TIMEOUT`.
fn wait<T: windows::core::RuntimeType + 'static>(operation: &IAsyncOperation<T>) -> Option<T> {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        match operation.Status().ok()? {
            AsyncStatus::Completed => return operation.GetResults().ok(),
            AsyncStatus::Started if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5))
            }
            _ => {
                let _ = operation.Cancel();
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_browser_app_ids_to_their_executables() {
        assert!(app_id_matches("MSEdge", "msedge"));
        assert!(app_id_matches("Chrome", "chrome"));
        assert!(app_id_matches("msedge.exe", "msedge"));
        assert!(!app_id_matches("Spotify.exe", "msedge"));
        assert!(!app_id_matches("MSEdge", ""));
    }

    #[test]
    fn works_out_the_current_position() {
        let second = 10_000_000;
        // Paused at 12:34: what was reported.
        assert_eq!(
            current_seconds(754 * second, 100, 999 * second, false),
            Some(754)
        );
        // Playing, reported 5 s ago at 12:34.
        assert_eq!(
            current_seconds(754 * second, 1_000 * second, 1_005 * second, true),
            Some(759)
        );
        assert_eq!(current_seconds(-1, 0, 0, false), None);
    }

    /// Reads the real media session (whatever is playing now, if anything).
    #[test]
    #[ignore = "needs a Windows desktop session"]
    fn reads_the_media_session() {
        let _com = super::super::ComThread::init().unwrap();
        let sessions = MediaSessions::new().expect("media session manager");
        eprintln!("msedge: {:?}", sessions.state_of("msedge.exe"));
        eprintln!("chrome: {:?}", sessions.state_of("chrome.exe"));
    }
}
