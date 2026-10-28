//! What Windows' media controls know about playing media.
//!
//! - For video (S3): whether the app in front is playing (so the tutor can ask to pause first)
//!   and where it is (a saved clip's timestamp). Only the playback state and position are read.
//! - For the island's music panel (`screen_music.rs`): the current session's title, artist and
//!   album art, shown on the island only (never sent, logged or saved), and its play/pause, next
//!   and previous buttons.
//!
//! Players and browsers publish what they play to the system media session (the same thing the
//! volume flyout shows).

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use windows::core::Interface;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Playback,
};
use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};
use windows_future::{AsyncStatus, IAsyncOperation};

use crate::screen::music::{art_mime, Control, NowPlaying, MAX_ART_BYTES};

/// Windows answers in a few milliseconds; a hung media service must never hold up a capture.
const TIMEOUT: Duration = Duration::from_millis(300);
/// Album art comes from the player and may take a little longer.
const ART_TIMEOUT: Duration = Duration::from_millis(1500);

/// What's playing now, and where its album art is (read separately, once per track).
pub struct Track {
    pub now: NowPlaying,
    pub thumbnail: Option<IRandomAccessStreamReference>,
}
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
            manager: wait(&request, TIMEOUT)?,
        })
    }

    /// The session Windows' media flyout shows (the player used most recently), if any.
    fn current(&self) -> Option<GlobalSystemMediaTransportControlsSession> {
        self.manager.GetCurrentSession().ok()
    }

    /// What the current session is playing (or has paused), with its buttons' state.
    pub fn now_playing(&self) -> Option<Track> {
        let session = self.current()?;
        let properties = wait(&session.TryGetMediaPropertiesAsync().ok()?, TIMEOUT)?;
        let app_id = session
            .SourceAppUserModelId()
            .map(|id| id.to_string_lossy())
            .unwrap_or_default();
        let mut now = NowPlaying::new(
            &properties.Title().ok()?.to_string_lossy(),
            &properties
                .Artist()
                .map(|artist| artist.to_string_lossy())
                .unwrap_or_default(),
            &app_id,
        )?;
        if let Ok(info) = session.GetPlaybackInfo() {
            now.playing = info
                .PlaybackStatus()
                .is_ok_and(|status| status == Playback::Playing);
            if let Ok(controls) = info.Controls() {
                now.can_next = controls.IsNextEnabled().unwrap_or(false);
                now.can_previous = controls.IsPreviousEnabled().unwrap_or(false);
            }
        }
        Some(Track {
            now,
            thumbnail: properties.Thumbnail().ok(),
        })
    }

    /// Presses a playback button on the current session. False if there's none or it refused.
    pub fn control(&self, control: Control) -> bool {
        let Some(session) = self.current() else {
            return false;
        };
        let operation = match control {
            Control::PlayPause => session.TryTogglePlayPauseAsync(),
            Control::Next => session.TrySkipNextAsync(),
            Control::Previous => session.TrySkipPreviousAsync(),
        };
        operation
            .ok()
            .and_then(|operation| wait(&operation, TIMEOUT))
            .unwrap_or(false)
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

/// A track's album art: its bytes and type, when it's a PNG or JPEG of at most `MAX_ART_BYTES`
/// (checked by the bytes, not by what the player says it is).
pub fn read_art(thumbnail: &IRandomAccessStreamReference) -> Option<(Vec<u8>, &'static str)> {
    let stream = wait(&thumbnail.OpenReadAsync().ok()?, ART_TIMEOUT)?;
    let size = u32::try_from(stream.Size().ok()?).ok()?;
    if size == 0 || size as usize > MAX_ART_BYTES {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).ok()?).ok()?;
    let load: IAsyncOperation<u32> = reader.LoadAsync(size).ok()?.cast().ok()?;
    let loaded = wait(&load, ART_TIMEOUT)?;
    let mut bytes = vec![0u8; loaded.min(size) as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    let mime = art_mime(&bytes)?;
    Some((bytes, mime))
}

/// Waits for an async operation, giving up after `timeout`.
fn wait<T: windows::core::RuntimeType + 'static>(
    operation: &IAsyncOperation<T>,
    timeout: Duration,
) -> Option<T> {
    let deadline = Instant::now() + timeout;
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

    /// Reads what's playing for the island (play something in Spotify or a browser first).
    #[test]
    #[ignore = "needs a Windows desktop session"]
    fn reads_what_is_playing() {
        let _com = super::super::ComThread::init().unwrap();
        let sessions = MediaSessions::new().expect("media session manager");
        let track = sessions.now_playing();
        eprintln!("now: {:?}", track.as_ref().map(|track| &track.now));
        let art = track
            .and_then(|track| track.thumbnail)
            .and_then(|thumbnail| read_art(&thumbnail));
        eprintln!("art: {:?}", art.map(|(bytes, mime)| (bytes.len(), mime)));
    }
}
