//! One capture from start to finish, in the order the brief requires (§7):
//!
//!   1. privacy checks: microphone, calls, the app in front, password fields → maybe refuse
//!   2. capture one frame of the window or monitor
//!   3. monitor captures: black out every window of a blocked app or private browser
//!   4. OCR the frame and cover sensitive text (fail closed: no OCR, no picture)
//!   5. downscale and encode to JPEG, all in memory
//!
//! The redacted pixels and the text left visible are kept with the frame (S3): to place ink
//! beside the text, and to clip from if the student saves. They never leave Rust except in a
//! clip the student confirmed.
//!
//! Runs on the capture worker thread, which owns the Windows objects in `Tools`.

use std::time::Instant;

use super::config::{CaptureScope, Privacy};
use super::frame::{FrameDetail, FrameMeta, Timings};
use super::image::{
    downscale_bgra_to_bgr, downscale_bgra_to_gray, looks_blank, Pixels, MAX_LONG_SIDE,
};
use super::privacy::blocklist::is_blocked;
use super::privacy::private_window::is_private_window;
use super::privacy::redact::{
    fill, rects_to_cover, screen_to_pixels, PixelRect, BLACKED_OUT, REDACTED,
};
use super::privacy::{may_capture, Focus, Refusal, Situation};
use super::screen_text::ScreenText;
use super::secret::SecretBytes;
use super::win::capture::{CaptureError, Capturer};
use super::win::encode::encode_jpeg;
use super::win::media_session::{MediaSessions, MediaState};
use super::win::ocr::{Ocr, OcrError};
use super::win::system;
use super::win::target::{self, Target};
use super::win::uia::Automation;

/// What one capture should do: where to look, and the privacy settings at the moment of asking.
pub struct Request {
    pub scope: CaptureScope,
    pub privacy: Privacy,
}

pub struct Captured {
    pub jpeg: SecretBytes,
    pub meta: FrameMeta,
    pub detail: FrameDetail,
}

/// Why there's no picture, phrased for the user (never raw errors, brief §10).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScreenError {
    Refused(Refusal),
    NothingToSee,
    Blank,
    NoOcrLanguage,
    RedactionFailed,
    Failed,
}

impl ScreenError {
    pub fn message(&self) -> String {
        match self {
            ScreenError::Refused(refusal) => refusal.message(),
            ScreenError::NothingToSee => "I couldn't find a window to look at. Click the app you want help with, then ask again.".into(),
            ScreenError::Blank => "That window looks black to me. Games in exclusive fullscreen and protected videos can't be captured.".into(),
            ScreenError::NoOcrLanguage => "Screen Coach hides card numbers and passwords using Windows' text recognition, which isn't installed for your language. Add a language with \"Optical character recognition\" in Windows Settings → Time & language → Language & region.".into(),
            ScreenError::RedactionFailed => "I couldn't check your screen for private details, so I didn't look. Please try again.".into(),
            ScreenError::Failed => "I couldn't look at your screen just now. If a Windows security prompt is open, I can't see it; otherwise try again in a moment.".into(),
        }
    }
}

/// Windows objects that are slow to create, kept by the worker thread between captures.
#[derive(Default)]
pub struct Tools {
    capturer: Option<Capturer>,
    automation: Option<Automation>,
    ocr: Option<Ocr>,
    media: Option<MediaSessions>,
}

impl Tools {
    /// What Windows' media controls say about `app`'s video, if anything.
    pub fn media_state(&mut self, app: &str) -> Option<MediaState> {
        if self.media.is_none() {
            self.media = MediaSessions::new();
        }
        self.media.as_ref()?.state_of(app)
    }

    /// A browser window's address bar text (only read for a clip being saved).
    pub fn address_bar(&mut self, window: windows::Win32::Foundation::HWND) -> Option<String> {
        if self.automation.is_none() {
            self.automation = Automation::new().ok();
        }
        self.automation.as_ref()?.address_bar(window)
    }
}

/// Runs one capture. Every early return drops (and so wipes) the pixels captured so far.
pub fn run(tools: &mut Tools, request: &Request) -> Result<Captured, ScreenError> {
    let target = match request.scope {
        CaptureScope::Window => target::ask_target(),
        CaptureScope::Monitor => target::monitor_target(),
    }
    .ok_or(ScreenError::NothingToSee)?;
    run_on(tools, &target, &request.privacy)
}

/// The pipeline for a target already chosen (tests use it with a window they drew).
pub fn run_on(
    tools: &mut Tools,
    target: &Target,
    privacy: &Privacy,
) -> Result<Captured, ScreenError> {
    let started = Instant::now();
    may_capture(&situation(tools, target, privacy)).map_err(ScreenError::Refused)?;
    let checks_ms = elapsed_ms(started);

    let started = Instant::now();
    let mut raw = capture(tools, target)?;
    let capture_ms = elapsed_ms(started);
    if looks_blank(&raw) {
        return Err(ScreenError::Blank);
    }

    let started = Instant::now();
    let mut hidden = Vec::new();
    if target.kind == super::frame::TargetKind::Monitor {
        hidden = black_out_blocked_windows(&mut raw, target, privacy);
    }
    let blacked_out = hidden.clone();
    let text = cover_sensitive_text(tools, &mut raw, target, privacy, hidden)?;
    let redact_ms = elapsed_ms(started);

    let started = Instant::now();
    let small = downscale_bgra_to_bgr(&raw, MAX_LONG_SIDE);
    let downscale_ms = elapsed_ms(started);

    let started = Instant::now();
    let jpeg = encode_jpeg(&small).map_err(|_| ScreenError::Failed)?;
    let encode_ms = elapsed_ms(started);

    let video_playing = target
        .app
        .as_deref()
        .and_then(|app| tools.media_state(app))
        .map(|state| state.playing);
    let meta = FrameMeta {
        kind: target.kind,
        app: target.app.clone(),
        bounds: target.bounds,
        monitor: target.monitor_rect,
        dpi: target.dpi,
        width: small.width,
        height: small.height,
        timings: Timings {
            checks_ms,
            capture_ms,
            redact_ms,
            downscale_ms,
            encode_ms,
        },
        video_playing,
        window: target.foreground.map(|hwnd| hwnd.0 as isize),
    };
    Ok(Captured {
        jpeg,
        meta,
        detail: FrameDetail {
            pixels: raw,
            text,
            blacked_out,
        },
    })
}

/// The privacy checks alone, for the app in front right now: a held screenshot is only clipped
/// if a capture would be allowed at this moment too (no password field, no blocked app).
pub fn may_use_screen_now(tools: &mut Tools, privacy: &Privacy) -> Result<(), ScreenError> {
    let target = target::ask_target().ok_or(ScreenError::NothingToSee)?;
    may_capture(&situation(tools, &target, privacy)).map_err(ScreenError::Refused)
}

/// Everything the privacy rules need to know about this moment.
fn situation(tools: &mut Tools, target: &Target, privacy: &Privacy) -> Situation {
    let app = target.app.clone();
    let private_window = match (target.foreground, &app) {
        (Some(window), Some(app)) => is_private_window(app, &target::window_title(window)),
        _ => false,
    };
    if tools.automation.is_none() {
        tools.automation = Automation::new().ok();
    }
    Situation {
        mic: system::mic_access(),
        // Only look for calls when the setting asks us to.
        in_call: privacy.pause_during_calls && system::call_or_recording_in_progress(),
        pause_during_calls: privacy.pause_during_calls,
        app_unreadable: target.foreground.is_some() && app.is_none(),
        app_blocked: app
            .as_deref()
            .is_some_and(|app| is_blocked(app, &privacy.blocked_apps)),
        app,
        private_window,
        focus: tools
            .automation
            .as_ref()
            .map_or(Focus::Unknown, Automation::focus),
    }
}

fn capture(tools: &mut Tools, target: &Target) -> Result<Pixels, ScreenError> {
    if tools.capturer.is_none() {
        tools.capturer = Capturer::new().ok();
    }
    let capturer = tools.capturer.as_ref().ok_or(ScreenError::Failed)?;
    capturer.capture(target).map_err(|error| match error {
        CaptureError::TargetGone => ScreenError::NothingToSee,
        CaptureError::Windows(_) => {
            // A lost device (driver update, GPU reset) is recreated on the next capture.
            tools.capturer = None;
            ScreenError::Failed
        }
        CaptureError::Timeout | CaptureError::TooLarge => ScreenError::Failed,
    })
}

/// Monitor captures can include other windows: black out any that belong to a blocked app or
/// a private browser, or whose app we can't identify (decision 6). Returns what was covered.
fn black_out_blocked_windows(
    raw: &mut Pixels,
    target: &Target,
    privacy: &Privacy,
) -> Vec<PixelRect> {
    let rects: Vec<_> = target::visible_windows_over(target.bounds)
        .into_iter()
        .filter(|window| match &window.app {
            Some(app) => {
                is_blocked(app, &privacy.blocked_apps) || is_private_window(app, &window.title)
            }
            None => true,
        })
        .filter_map(|window| screen_to_pixels(window.bounds, target.bounds, raw.width, raw.height))
        .collect();
    fill(raw, &rects, BLACKED_OUT);
    rects
}

/// Reads the text on screen, covers what the redaction rules ask for, and returns the text that
/// is still visible (none of it under `hidden` or a covered area). If any rule is on and OCR
/// can't run, nothing is sent (fail closed); with every rule off, OCR is only for placing ink,
/// so a failure just means no text.
fn cover_sensitive_text(
    tools: &mut Tools,
    raw: &mut Pixels,
    target: &Target,
    privacy: &Privacy,
    mut hidden: Vec<PixelRect>,
) -> Result<ScreenText, ScreenError> {
    let rules = &privacy.redaction;
    let required = rules.cards || rules.secrets || rules.codes || rules.emails || rules.phones;
    let fail = |error: ScreenError| {
        if required {
            Err(error)
        } else {
            Ok(ScreenText::default())
        }
    };
    if tools.ocr.is_none() {
        match Ocr::new() {
            Ok(ocr) => tools.ocr = Some(ocr),
            Err(OcrError::NoLanguage) => return fail(ScreenError::NoOcrLanguage),
            Err(OcrError::Windows(_)) => return fail(ScreenError::RedactionFailed),
        }
    }
    let Some(ocr) = tools.ocr.as_ref() else {
        return fail(ScreenError::RedactionFailed);
    };
    let grey = downscale_bgra_to_gray(raw, ocr.max_side());
    let scale = raw.width as f32 / grey.width as f32;
    let lines = match ocr.read(&grey) {
        Ok(lines) => lines,
        Err(_) => return fail(ScreenError::RedactionFailed),
    };
    drop(grey);
    let rects = rects_to_cover(&lines, rules, scale, raw.width, raw.height);
    fill(raw, &rects, REDACTED);
    hidden.extend(rects);
    Ok(ScreenText::from_ocr(
        &lines,
        scale,
        (raw.width, raw.height),
        target.bounds,
        &hidden,
    ))
}

fn elapsed_ms(since: Instant) -> u32 {
    since.elapsed().as_millis().min(u128::from(u32::MAX)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_error_reads_as_plain_language() {
        let errors = [
            ScreenError::Refused(Refusal::PasswordField),
            ScreenError::NothingToSee,
            ScreenError::Blank,
            ScreenError::NoOcrLanguage,
            ScreenError::RedactionFailed,
            ScreenError::Failed,
        ];
        for error in errors {
            let message = error.message();
            assert!(
                message.len() > 20 && !message.contains("0x") && !message.contains("HRESULT"),
                "{message}"
            );
        }
    }

    /// Threat check 3: a test card number and API key are covered before upload, and ordinary
    /// text survives. Captures only a window this test draws itself.
    /// Run with `cargo test -- --ignored` on a desktop session with an OCR language installed.
    #[test]
    #[ignore = "needs an interactive Windows desktop, a GPU and an OCR language"]
    fn covers_a_card_number_and_a_key_but_keeps_ordinary_text() {
        use super::super::privacy::detect::find_sensitive;
        use super::super::win::test_window::TestWindow;
        use super::super::win::ComThread;

        let _com = ComThread::init().unwrap();
        let window = TestWindow::show(
            &[
                "Insert a PivotTable from the ribbon",
                "Card number 4242 4242 4242 4242",
                "AWS key AKIAIOSFODNN7EXAMPLE",
            ],
            900,
        );
        let target = target::window_target(window.hwnd).expect("target");
        let mut tools = Tools::default();
        let mut raw = capture(&mut tools, &target).expect("capture");
        drop(window);

        let privacy = Privacy::default();
        let ocr = Ocr::new().expect("an OCR language is installed");
        let read = |pixels: &Pixels| -> String {
            let grey = downscale_bgra_to_gray(pixels, ocr.max_side());
            let lines = ocr.read(&grey).expect("ocr");
            lines
                .iter()
                .map(|line| {
                    line.words
                        .iter()
                        .map(|w| w.text.as_str())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        let before = read(&raw);
        assert!(
            before.contains("4242"),
            "the test text must be readable first ({}x{}): {before}",
            raw.width,
            raw.height
        );

        let started = Instant::now();
        let text = cover_sensitive_text(&mut tools, &mut raw, &target, &privacy, Vec::new())
            .expect("redaction");
        let kept = text.text_in(target.bounds, &privacy.redaction);
        assert!(
            !kept.contains("4242") && !kept.contains("AKIA"),
            "the kept text hides what the image hides: {kept}"
        );
        let redact_ms = started.elapsed().as_millis();

        let after = read(&raw);
        assert!(
            find_sensitive(&after, &privacy.redaction).is_empty(),
            "still visible: {after}"
        );
        assert!(
            !after.contains("AKIA") && !after.contains("4242"),
            "{after}"
        );
        assert!(
            after.contains("PivotTable"),
            "ordinary text was covered too: {after}"
        );
        eprintln!(
            "redaction of a {}x{} capture took {redact_ms} ms",
            raw.width, raw.height
        );
    }
}
