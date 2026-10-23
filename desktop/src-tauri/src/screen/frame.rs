//! The one captured frame Screen Coach holds, in memory only, until it's sent or expires.
//!
//! Decision 2 (docs/SCREEN_COACH.md): screenshot bytes never enter a WebView. Only Rust code
//! takes a frame from the slot (the uploader, from S2); no command hands one to a page. The one
//! exception is a clip's local preview (S3), and only after the student asked to save.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::image::Pixels;
use super::screen_text::ScreenText;
use super::secret::SecretBytes;

/// A frame nobody used within this time is wiped.
pub const FRAME_TTL: Duration = Duration::from_secs(60);

/// A rectangle in physical screen pixels (virtual-screen coordinates: can be negative for
/// monitors left of or above the primary one).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ScreenRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl ScreenRect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    Window,
    Monitor,
}

/// What we know about a capture besides its pixels. No window titles, no paths.
#[derive(Debug, Clone)]
pub struct FrameMeta {
    pub kind: TargetKind,
    /// The foreground app's executable name (lowercase, no path), when known.
    pub app: Option<String>,
    /// Where the captured content is on screen.
    pub bounds: ScreenRect,
    /// The monitor the content is on.
    pub monitor: ScreenRect,
    /// That monitor's DPI (96 = 100 % scaling).
    pub dpi: u32,
    /// Size of the encoded image.
    pub width: u32,
    pub height: u32,
    pub timings: Timings,
    /// A video is playing in the app in front (Windows' media session), when Windows says.
    pub video_playing: Option<bool>,
    /// The window the student was working in (a raw HWND), for watching it while ink is shown.
    pub window: Option<isize>,
}

/// Milliseconds per stage, logged without content (brief §13).
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Timings {
    /// Privacy checks before capturing (microphone, calls, blocked apps, password field).
    pub checks_ms: u32,
    pub capture_ms: u32,
    /// Blacking out blocked windows, OCR and covering sensitive text.
    pub redact_ms: u32,
    pub downscale_ms: u32,
    pub encode_ms: u32,
}

/// What a capture keeps besides the JPEG it sends: the redacted pixels at full size (to clip
/// from) and the visible text (to place ink beside it). Wiped with the frame.
pub struct FrameDetail {
    /// BGRA, after blacking out blocked windows and covering sensitive text.
    pub pixels: Pixels,
    pub text: ScreenText,
}

pub struct CapturedFrame {
    pub id: u64,
    pub jpeg: SecretBytes,
    pub meta: FrameMeta,
    pub detail: Option<FrameDetail>,
    expires_at: Instant,
}

#[derive(Default)]
pub struct FrameSlot {
    state: Mutex<SlotState>,
}

#[derive(Default)]
struct SlotState {
    next_id: u64,
    frame: Option<CapturedFrame>,
}

impl FrameSlot {
    /// Stores a frame, replacing (and so wiping) any earlier one. Returns its id.
    pub fn put(
        &self,
        jpeg: SecretBytes,
        meta: FrameMeta,
        detail: Option<FrameDetail>,
        now: Instant,
    ) -> u64 {
        let mut state = self.lock();
        state.next_id += 1;
        let id = state.next_id;
        state.frame = Some(CapturedFrame {
            id,
            jpeg,
            meta,
            detail,
            expires_at: now + FRAME_TTL,
        });
        id
    }

    /// Hands over frame `id` (once): None if it was replaced, taken, cleared or has expired.
    pub fn take(&self, id: u64, now: Instant) -> Option<CapturedFrame> {
        let mut state = self.lock();
        match &state.frame {
            Some(frame) if frame.id == id && now < frame.expires_at => state.frame.take(),
            Some(frame) if now >= frame.expires_at => {
                state.frame = None;
                None
            }
            _ => None,
        }
    }

    /// Hands over whatever frame is held (once), unless it has expired.
    pub fn take_latest(&self, now: Instant) -> Option<CapturedFrame> {
        let id = self.lock().frame.as_ref()?.id;
        self.take(id, now)
    }

    /// Wipes the frame if it has expired (the sweeper calls this).
    pub fn expire(&self, now: Instant) {
        let mut state = self.lock();
        if state
            .frame
            .as_ref()
            .is_some_and(|frame| now >= frame.expires_at)
        {
            state.frame = None;
        }
    }

    /// Wipes whatever is held (pause, turning Screen Coach off).
    pub fn clear(&self) {
        self.lock().frame = None;
    }

    pub fn holds_frame(&self) -> bool {
        self.lock().frame.is_some()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, SlotState> {
        // A panic while holding the lock can't leave a frame half-written: recover the state.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> FrameMeta {
        let rect = ScreenRect {
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1080,
        };
        FrameMeta {
            kind: TargetKind::Monitor,
            app: None,
            bounds: rect,
            monitor: rect,
            dpi: 144,
            width: 1600,
            height: 900,
            timings: Timings::default(),
            video_playing: None,
            window: None,
        }
    }

    fn jpeg() -> SecretBytes {
        let mut bytes = SecretBytes::zeroed(4);
        bytes
            .as_mut_slice()
            .copy_from_slice(&[0xFF, 0xD8, 0xFF, 0xD9]);
        bytes
    }

    #[test]
    fn hands_a_frame_over_once() {
        let slot = FrameSlot::default();
        let now = Instant::now();
        let id = slot.put(jpeg(), meta(), None, now);
        let frame = slot.take(id, now).expect("frame");
        assert_eq!(frame.jpeg.as_slice(), &[0xFF, 0xD8, 0xFF, 0xD9]);
        assert!(slot.take(id, now).is_none(), "taken twice");
        assert!(!slot.holds_frame());
    }

    #[test]
    fn a_newer_capture_replaces_the_old_one() {
        let slot = FrameSlot::default();
        let now = Instant::now();
        let old = slot.put(jpeg(), meta(), None, now);
        let new = slot.put(jpeg(), meta(), None, now);
        assert_ne!(old, new);
        assert!(slot.take(old, now).is_none());
        assert!(slot.take(new, now).is_some());
    }

    #[test]
    fn frames_expire() {
        let slot = FrameSlot::default();
        let now = Instant::now();
        let id = slot.put(jpeg(), meta(), None, now);
        slot.expire(now + FRAME_TTL / 2);
        assert!(slot.holds_frame());
        slot.expire(now + FRAME_TTL);
        assert!(!slot.holds_frame());

        let id2 = slot.put(jpeg(), meta(), None, now);
        assert!(
            slot.take(id2, now + FRAME_TTL).is_none(),
            "expired frames aren't handed over"
        );
        assert!(!slot.holds_frame());
        let _ = id;
    }

    #[test]
    fn clear_wipes_everything() {
        let slot = FrameSlot::default();
        let now = Instant::now();
        let id = slot.put(jpeg(), meta(), None, now);
        slot.clear();
        assert!(slot.take(id, now).is_none());
    }

    #[test]
    fn rects_measure_negative_coordinates() {
        let rect = meta().bounds;
        assert_eq!((rect.width(), rect.height()), (1920, 1080));
    }
}
