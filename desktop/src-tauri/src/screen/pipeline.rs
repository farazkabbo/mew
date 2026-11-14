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
use super::frame::{FrameDetail, FrameMeta, ScreenRect, Timings};
use super::image::{
    dark_percent, downscale_bgra_to_bgr, downscale_bgra_to_gray, looks_blank, Pixels, MAX_LONG_SIDE,
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
use super::win::indicator;
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

/// Takes Neb's overlays out of the picture until what it returns is dropped.
type HideOverlays = Box<dyn Fn() -> Option<Box<dyn std::any::Any>>>;

/// Windows objects that are slow to create, kept by the worker thread between captures.
#[derive(Default)]
pub struct Tools {
    capturer: Option<Capturer>,
    automation: Option<Automation>,
    ocr: Option<Ocr>,
    media: Option<MediaSessions>,
    /// Takes Neb's overlays out of the picture until what it returns is dropped.
    pub hide_overlays: Option<HideOverlays>,
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

    // The frame is on the monitor before a pixel is read, or nothing is read (decision U9).
    let frame = indicator::Frame::hold(target.monitor_rect, target.dpi).ok_or_else(|| {
        eprintln!("[screen] capture failed: the on-screen frame wouldn't show");
        ScreenError::Failed
    })?;
    let started = Instant::now();
    let mut raw = capture(tools, target, &frame.token())?;
    drop(frame);
    let capture_ms = elapsed_ms(started);
    if looks_blank(&raw) {
        return Err(ScreenError::Blank);
    }

    let started = Instant::now();
    let mut hidden = Vec::new();
    let mut unidentified = 0;
    if target.kind == super::frame::TargetKind::Monitor {
        (hidden, unidentified) = black_out_blocked_windows(&mut raw, target, privacy);
    }
    let blacked_percent = covered_percent(&hidden, raw.width, raw.height);
    let blacked_out = hidden.clone();
    let text = cover_sensitive_text(tools, &mut raw, target, privacy, hidden)?;
    let redact_ms = elapsed_ms(started);

    let started = Instant::now();
    let small = downscale_bgra_to_bgr(&raw, MAX_LONG_SIDE);
    let downscale_ms = elapsed_ms(started);
    // Numbers only: how much was blacked out for privacy, and how dark the frame came out.
    eprintln!(
        "[screen] frame: blacked out {blacked_percent}% ({} windows, {unidentified} unidentified), dark {}%",
        blacked_out.len(),
        dark_percent(&small)
    );

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

/// The only place pixels are read: it needs the frame's token (a frame on screen).
fn capture(
    tools: &mut Tools,
    target: &Target,
    _frame: &indicator::FrameToken<'_>,
) -> Result<Pixels, ScreenError> {
    if tools.capturer.is_none() {
        tools.capturer = Capturer::new().ok();
    }
    let _overlays_hidden = tools.hide_overlays.as_ref().and_then(|hide| hide());
    let capturer = tools.capturer.as_ref().ok_or_else(|| {
        eprintln!("[screen] capture failed: couldn't start the capturer");
        ScreenError::Failed
    })?;
    capturer.capture(target).map_err(|error| match error {
        CaptureError::TargetGone => ScreenError::NothingToSee,
        CaptureError::Windows(ref cause) => {
            eprintln!("[screen] capture failed: Windows said {cause:?}");
            // A lost device (driver update, GPU reset) is recreated on the next capture.
            tools.capturer = None;
            ScreenError::Failed
        }
        CaptureError::Timeout | CaptureError::TooLarge => {
            eprintln!("[screen] capture failed: timed out or too large");
            ScreenError::Failed
        }
    })
}

/// Monitor captures can include other windows: black out any that belong to a blocked app or
/// a private browser, or whose app we can't identify (decision 6), where they show. A blocked
/// window behind others (Discord maximised behind the browser) is only blacked out where it
/// isn't covered: covering all of it hid the whole screen. Only opaque windows count as
/// covering (a see-through overlay never hides a blocked app). Returns what was covered, and
/// how many windows couldn't be identified.
fn black_out_blocked_windows(
    raw: &mut Pixels,
    target: &Target,
    privacy: &Privacy,
) -> (Vec<PixelRect>, usize) {
    let windows = target::visible_windows_over(target.bounds);
    let unidentified = windows.iter().filter(|w| w.app.is_none()).count();
    let mut above: Vec<ScreenRect> = Vec::new();
    let mut rects = Vec::new();
    for window in &windows {
        let hidden = match &window.app {
            Some(app) => {
                is_blocked(app, &privacy.blocked_apps) || is_private_window(app, &window.title)
            }
            None => true,
        };
        if hidden {
            rects.extend(
                visible_parts(window.bounds, &above)
                    .into_iter()
                    .filter_map(|part| {
                        screen_to_pixels(part, target.bounds, raw.width, raw.height)
                    }),
            );
        }
        if window.opaque {
            above.push(window.bounds);
        }
    }
    fill(raw, &rects, BLACKED_OUT);
    (rects, unidentified)
}

/// What's left of `rect` once every rectangle in `covers` is taken out of it (as up to four
/// pieces per cover, never overlapping).
pub fn visible_parts(rect: ScreenRect, covers: &[ScreenRect]) -> Vec<ScreenRect> {
    let mut parts = vec![rect];
    for cover in covers {
        let mut next = Vec::with_capacity(parts.len());
        for part in parts {
            if !target::overlaps(part, *cover) {
                next.push(part);
                continue;
            }
            // Above, below, then left and right of the cover, within the part.
            if cover.top > part.top {
                next.push(ScreenRect {
                    bottom: cover.top,
                    ..part
                });
            }
            if cover.bottom < part.bottom {
                next.push(ScreenRect {
                    top: cover.bottom,
                    ..part
                });
            }
            let top = part.top.max(cover.top);
            let bottom = part.bottom.min(cover.bottom);
            if cover.left > part.left {
                next.push(ScreenRect {
                    top,
                    bottom,
                    right: cover.left,
                    ..part
                });
            }
            if cover.right < part.right {
                next.push(ScreenRect {
                    top,
                    bottom,
                    left: cover.right,
                    ..part
                });
            }
        }
        parts = next;
    }
    parts
}

/// How much of a frame some rectangles cover, in percent (an estimate: overlaps count twice,
/// capped at 100).
fn covered_percent(rects: &[PixelRect], width: u32, height: u32) -> u64 {
    let total = u64::from(width) * u64::from(height);
    if total == 0 {
        return 0;
    }
    let covered: u64 = rects
        .iter()
        .map(|r| u64::from(r.right - r.left) * u64::from(r.bottom - r.top))
        .sum();
    (covered * 100 / total).min(100)
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

    /// Decision U9: no capture while the frame is off. Pixels are read in one place, the
    /// pipeline's `capture`, which takes the frame's token (only a frame on screen lends one);
    /// this checks that no other code reads the screen.
    #[test]
    fn every_capture_needs_the_frame() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = vec![src.clone()];
        let mut sources = Vec::new();
        while let Some(path) = files.pop() {
            if path.is_dir() {
                files.extend(std::fs::read_dir(&path).unwrap().map(|e| e.unwrap().path()));
            } else if path.extension().is_some_and(|e| e == "rs") {
                let text = std::fs::read_to_string(&path).unwrap();
                // Tests (at the end of each file) capture windows they drew themselves.
                let code = text.split("#[cfg(test)]").next().unwrap_or("").to_owned();
                sources.push((path, code));
            }
        }
        let mut readers = Vec::new();
        for (path, code) in &sources {
            for (n, line) in code.lines().enumerate() {
                if line.contains("capturer.capture(") || line.contains("Capturer::new(") {
                    readers.push(format!("{}:{}", path.display(), n + 1));
                }
            }
        }
        assert!(
            readers.iter().all(|r| r.contains("pipeline.rs")),
            "the screen is read outside the pipeline: {readers:?}"
        );
        let pipeline = &sources
            .iter()
            .find(|(p, _)| p.ends_with("screen/pipeline.rs"))
            .unwrap()
            .1;
        let signature = pipeline.split("fn capture(").nth(1).unwrap();
        let signature = &signature[..signature.find('{').unwrap()];
        assert!(
            signature.contains("FrameToken"),
            "the pipeline's capture must take the frame's token"
        );
        // And the pipeline holds the frame before it reads a pixel.
        let hold = pipeline.find("Frame::hold(").unwrap();
        let read = pipeline
            .find("capture(tools, target, &frame.token())")
            .unwrap();
        assert!(hold < read);
    }

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> ScreenRect {
        ScreenRect {
            left,
            top,
            right,
            bottom,
        }
    }

    fn area(parts: &[ScreenRect]) -> i64 {
        parts
            .iter()
            .map(|r| i64::from(r.width()) * i64::from(r.height()))
            .sum()
    }

    #[test]
    fn a_blocked_window_behind_another_is_blacked_out_only_where_it_shows() {
        let screen = rect(0, 0, 1920, 1080);
        // Discord maximised behind a maximised browser: nothing of it shows.
        assert!(visible_parts(screen, &[screen]).is_empty());
        // Behind a window that covers the left half: only the right half shows.
        let parts = visible_parts(screen, &[rect(0, 0, 960, 1080)]);
        assert_eq!(parts, vec![rect(960, 0, 1920, 1080)]);
        // A window in the middle: a frame of four pieces around it, never overlapping.
        let parts = visible_parts(screen, &[rect(400, 300, 1400, 800)]);
        assert_eq!(area(&parts), 1920 * 1080 - 1000 * 500);
        for (i, a) in parts.iter().enumerate() {
            for b in &parts[i + 1..] {
                assert!(!target::overlaps(*a, *b), "{a:?} overlaps {b:?}");
            }
        }
        // Nothing in front: all of it.
        assert_eq!(visible_parts(screen, &[]), vec![screen]);
        // Two covers: what neither hides.
        let parts = visible_parts(screen, &[rect(0, 0, 960, 1080), rect(960, 0, 1920, 540)]);
        assert_eq!(parts, vec![rect(960, 540, 1920, 1080)]);
    }

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
        let frame = indicator::Frame::hold(target.monitor_rect, target.dpi).expect("frame");
        let mut raw = capture(&mut tools, &target, &frame.token()).expect("capture");
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
