//! One explicit, in-process Mac capture. This module has no IPC, files, provider or permission
//! request path. Production callers must supply a bounded main-queue policy sampler; the
//! AX private-browser Unknown remains Unknown and refuses. The limited call detector is
//! explicitly distinguished from universal absence and from a local call-policy opt-out.
//! A sampler is a trusted native boundary, not data accepted from a webview. No default sampler
//! manufactures authorization. Monitor requests bind every visible-window inventory and
//! conservatively composite only the authorized foreground window onto a black display.
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use super::{capture, privacy::ProcessIdentity, target::Rect};
use crate::screen::{
    frame::ScreenRect,
    image::{self, Pixels},
    privacy::{detect::RedactionRules, redact::OcrLine, Focus},
    screen_text::ScreenText,
    secret::{wipe, SecretBytes},
};

const MAX_RAW_BYTES: usize = 128 * 1024 * 1024;
const MAX_JPEG_BYTES: usize = 16 * 1024 * 1024;
const MAX_REQUEST_AGE: Duration = Duration::from_secs(15);
// Includes bounded worker-side browser automation; each main-queue dispatch remains <=450ms.
const MAX_SAMPLE_TIME: Duration = Duration::from_secs(3);
const MAX_OCR_TEXT: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intent {
    Ask,
    Circle,
    Clip,
}

/// One exact window and its owning process launch, in global top-left Quartz POINTS.
/// Full display capture is not representable here: foreground policy cannot authorize the
/// other applications and private windows visible on a display.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub window_id: u32,
    pub process: ProcessIdentity,
    pub quartz_points: Rect,
}

/// Every visible non-Neb window is bound into a display request. Unknown contexts are never
/// inferred safe: the monitor policy blacks all other windows and everything outside the
/// positively authorized foreground window, before OCR, encoding, or retention.
#[derive(Debug, Clone, PartialEq)]
pub struct VisibleWindow {
    pub id: u32,
    pub pid: i32,
    pub bounds: Rect,
    pub layer: i32,
}
#[derive(Debug, Clone, PartialEq)]
pub struct Monitor {
    pub id: u32,
    pub bounds: Rect,
    pub windows: Vec<VisibleWindow>,
}

#[derive(Clone)]
pub struct Request {
    pub target: Target,
    pub monitor: Option<Monitor>,
    pub intent: Intent,
    /// Increment the shared generation on disable, pause, cancellation, or a new intent.
    pub generation: u64,
    pub issued_at: Instant,
    pub timeout: Duration,
    pub rules: RedactionRules,
    /// Exact local setting, bound into every policy proof.
    pub pause_during_calls: bool,
}

/// Positive absence evidence must come from an appropriate trusted native source. Absence of
/// metadata or permission is Unknown, not Clear. In particular AX ordinary focus proves
/// neither private-window absence nor call/share absence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Evidence {
    Clear,
    Present,
    Unknown,
    /// Windows-equivalent limited detector: known apps and input devices only.
    KnownSignalsIdle,
    /// Explicit local pause-during-calls opt-out; never a claim about OS state.
    DisabledByLocalPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Checkpoint {
    BeforeCapture,
    NativeBoundary,
    AfterCapture,
    AfterOcr,
    AfterRedaction,
    BeforeEncode,
    BeforeDelivery,
}

/// A fresh snapshot of current native policy. `sampled_at` must be taken on the main queue
/// after all observations, during this invocation; never replay an earlier snapshot. The
/// sampler must time out its main-queue dispatch and AX reads, without waiting indefinitely.
/// A successful indicator acknowledgment means the indicator was actually presented for this
/// request and remains visible, not merely that showing it was queued.
#[derive(Debug, Clone)]
pub struct PolicyProof {
    pub monitor: Option<Monitor>,
    pub sampled_at: Instant,
    pub sampled_on_main_queue: bool,
    pub serial: u64,
    pub target: Target,
    pub intent: Intent,
    pub generation: u64,
    pub opted_in: bool,
    pub paused: bool,
    pub screen_permission: bool,
    pub accessibility_permission: bool,
    pub indicator_presented: bool,
    pub focus: Focus,
    pub blocked_application: Evidence,
    pub private_browsing: Evidence,
    pub call_or_share: Evidence,
    pub pause_during_calls: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidRequest,
    Cancelled,
    Timeout,
    StalePolicy,
    PolicyUnavailable,
    Permission,
    IndicatorUnavailable,
    ProtectedFocus,
    UnknownFocus,
    BlockedApplication,
    PrivateBrowsing,
    CallOrShare,
    UnknownPrivacy,
    InvalidFrame,
    InvalidOcr,
    BlankFrame,
    InvalidEncoding,
    Native(capture::Error),
}

/// Safe to inject a synthetic implementation in tests. Production uses NativeService; service
/// implementations must never retain inputs or send pixels/text elsewhere. `capture` MUST
/// call the mutable guard before acquisition and at each native asynchronous/use boundary.
pub trait Service {
    fn capture(
        &mut self,
        target: &Target,
        monitor: Option<&Monitor>,
        guard: &mut dyn FnMut() -> bool,
    ) -> Result<Pixels, capture::Error>;
    fn recognize(&mut self, pixels: &Pixels) -> Result<Vec<OcrLine>, capture::Error>;
    fn encode(&mut self, redacted: &Pixels) -> Result<SecretBytes, capture::Error>;
}

pub struct NativeService;
impl Service for NativeService {
    fn capture(
        &mut self,
        target: &Target,
        monitor: Option<&Monitor>,
        guard: &mut dyn FnMut() -> bool,
    ) -> Result<Pixels, capture::Error> {
        // A raw display may reveal background through a translucent foreground window.
        // Instead compose only the exact authorized window on a black monitor canvas. The
        // public display capture adapter is not sufficient proof of opaque target content.
        let pixels = capture::capture(
            capture::Target::Window {
                id: target.window_id,
                pid: target.process.pid,
                bounds: target.quartz_points,
            },
            guard,
        )?;
        if !guard() {
            return Err(capture::Error::Cancelled);
        }
        let result = match monitor {
            Some(m) => compose_monitor(pixels, target.quartz_points, m.bounds),
            None => Ok(pixels),
        };
        if !guard() {
            return Err(capture::Error::Cancelled);
        }
        result
    }

    fn recognize(&mut self, pixels: &Pixels) -> Result<Vec<OcrLine>, capture::Error> {
        capture::recognize(pixels)
    }
    fn encode(&mut self, redacted: &Pixels) -> Result<SecretBytes, capture::Error> {
        capture::encode_jpeg(redacted, 0.8)
    }
}

/// Compose no background pixels at all: transparent target pixels are premultiplied over
/// black. Source/canvas retain separate ownership and wipe on every success or error path.
fn compose_monitor(source: Pixels, window: Rect, monitor: Rect) -> Result<Pixels, capture::Error> {
    if !valid_frame(&source) {
        return Err(capture::Error::Invalid);
    }
    let sx = f64::from(source.width) / window.width;
    let sy = f64::from(source.height) / window.height;
    let width = (monitor.width * sx).ceil();
    let height = (monitor.height * sy).ceil();
    if !width.is_finite()
        || !height.is_finite()
        || width < 1.
        || height < 1.
        || width > 16384.
        || height > 16384.
    {
        return Err(capture::Error::TooLarge);
    }
    let (width, height) = (width as u32, height as u32);
    let bytes = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
        .filter(|n| *n <= MAX_RAW_BYTES)
        .ok_or(capture::Error::TooLarge)?;
    let mut data = Vec::new();
    data.try_reserve_exact(bytes)
        .map_err(|_| capture::Error::TooLarge)?;
    data.resize(bytes, 0);
    for pixel in data.chunks_exact_mut(4) {
        pixel[3] = 255;
    }
    let ox = ((window.x - monitor.x) * sx).round() as i64;
    let oy = ((window.y - monitor.y) * sy).round() as i64;
    for y in 0..source.height {
        let dy = oy + i64::from(y);
        if dy < 0 || dy >= i64::from(height) {
            continue;
        }
        for x in 0..source.width {
            let dx = ox + i64::from(x);
            if dx < 0 || dx >= i64::from(width) {
                continue;
            }
            let from = ((y as usize) * (source.width as usize) + x as usize) * 4;
            let to = ((dy as usize) * (width as usize) + dx as usize) * 4;
            data[to..to + 3].copy_from_slice(&source.data.as_slice()[from..from + 3]);
        }
    }
    Ok(Pixels {
        width,
        height,
        channels: 4,
        data: SecretBytes::from_vec(data),
    })
}

/// Coordinates are deliberately not a Windows global physical ScreenRect. Scale an image-local
/// box through these dimensions into Quartz points, then through the destination display's
/// point/pixel transform. Encoded JPEG may have a smaller size than the captured/OCR image.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Metadata {
    pub quartz_points: Rect,
    pub captured_pixels: (u32, u32),
    pub encoded_pixels: (u32, u32),
    pub generation: u64,
    pub intent: Intent,
}

pub struct LocalText(ScreenText);
impl LocalText {
    /// These boxes are LOCAL capture-image pixels with origin (0,0), never global screen pixels.
    pub fn image_pixel_boxes(&self) -> impl Iterator<Item = ScreenRect> + '_ {
        self.0.rects()
    }
    /// In-process access for a future adapter, which must transform its local rectangles before
    /// invoking shared global-screen consumers. Text is already redacted and wiped on drop.
    pub fn in_image_pixels(&self) -> &ScreenText {
        &self.0
    }
}

/// Owned sensitive buffers are wiped on drop. No Serialize/Clone and no raw pixels escape.
/// A caller must revalidate generation/policy again at any later asynchronous use boundary;
/// returning here only authorizes this one synchronous delivery, not an eventual network send.
pub struct Captured {
    pub jpeg: SecretBytes,
    /// Full-resolution BGRA AFTER mandatory redaction, exclusively owned and wiped on drop.
    pub pixels: Pixels,
    pub blacked_out: Vec<crate::screen::privacy::redact::PixelRect>,
    pub text: LocalText,
    pub metadata: Metadata,
}

struct Gate<'a, F> {
    request: &'a Request,
    generation: &'a AtomicU64,
    sampler: &'a mut F,
    last_serial: Option<u64>,
    require_indicator: bool,
}
impl<F: FnMut(&Request, Checkpoint) -> Result<PolicyProof, Error>> Gate<'_, F> {
    fn live(&self) -> Result<(), Error> {
        if self.generation.load(Ordering::SeqCst) != self.request.generation {
            return Err(Error::Cancelled);
        }
        let age = Instant::now()
            .checked_duration_since(self.request.issued_at)
            .ok_or(Error::InvalidRequest)?;
        if age >= self.request.timeout {
            return Err(Error::Timeout);
        }
        Ok(())
    }
    fn check(&mut self, stage: Checkpoint) -> Result<(), Error> {
        self.live()?;
        let started = Instant::now();
        let proof = (self.sampler)(self.request, stage)?;
        let ended = Instant::now();
        self.live()?;
        if ended.duration_since(started) > MAX_SAMPLE_TIME {
            return Err(Error::Timeout);
        }
        if !proof.sampled_on_main_queue
            || proof.sampled_at < started
            || proof.sampled_at > ended
            || self.last_serial.is_some_and(|last| proof.serial <= last)
        {
            return Err(Error::StalePolicy);
        }
        self.last_serial = Some(proof.serial);
        if proof.monitor != self.request.monitor
            || proof.target != self.request.target
            || proof.intent != self.request.intent
            || proof.generation != self.request.generation
            || proof.pause_during_calls != self.request.pause_during_calls
        {
            return Err(Error::StalePolicy);
        }
        if !proof.opted_in || proof.paused {
            return Err(Error::Cancelled);
        }
        if !proof.screen_permission || !proof.accessibility_permission {
            return Err(Error::Permission);
        }
        if self.require_indicator && !proof.indicator_presented {
            return Err(Error::IndicatorUnavailable);
        }
        match proof.focus {
            Focus::Password => return Err(Error::ProtectedFocus),
            Focus::Unknown => return Err(Error::UnknownFocus),
            Focus::Ordinary => {}
        }
        for (evidence, refusal) in [
            (proof.blocked_application, Error::BlockedApplication),
            (proof.private_browsing, Error::PrivateBrowsing),
        ] {
            match evidence {
                Evidence::Clear => {}
                Evidence::Present => return Err(refusal),
                _ => return Err(Error::UnknownPrivacy),
            }
        }
        match (self.request.pause_during_calls, proof.call_or_share) {
            (true, Evidence::Clear | Evidence::KnownSignalsIdle)
            | (false, Evidence::DisabledByLocalPolicy) => {}
            (_, Evidence::Present) => return Err(Error::CallOrShare),
            _ => return Err(Error::UnknownPrivacy),
        }
        Ok(())
    }
}

/// Reauthorize an owned frame at a later worker-side use boundary. This performs the same
/// bounded fresh native-policy checks as capture, including the original request deadline.
pub fn revalidate<F>(
    request: &Request,
    generation: &AtomicU64,
    sampler: &mut F,
) -> Result<(), Error>
where
    F: FnMut(&Request, Checkpoint) -> Result<PolicyProof, Error>,
{
    if !valid_request(request) {
        return Err(Error::InvalidRequest);
    }
    Gate {
        request,
        generation,
        sampler,
        last_serial: None,
        require_indicator: true,
    }
    .check(Checkpoint::BeforeDelivery)
}

/// Metadata-only authorization for preflight and an already-redacted frame. This cannot
/// acquire pixels and deliberately does not turn missing indicator proof into presentation.
pub(crate) fn revalidate_metadata<F>(
    request: &Request,
    generation: &AtomicU64,
    sampler: &mut F,
) -> Result<(), Error>
where
    F: FnMut(&Request, Checkpoint) -> Result<PolicyProof, Error>,
{
    if !valid_request(request) {
        return Err(Error::InvalidRequest);
    }
    Gate {
        request,
        generation,
        sampler,
        last_serial: None,
        require_indicator: false,
    }
    .check(Checkpoint::BeforeDelivery)
}

fn valid_request(request: &Request) -> bool {
    let target = &request.target;
    let p = &target.process;
    let r = target.quartz_points;
    request.monitor.as_ref().is_none_or(|m| m.id!=0 && Rect::new(m.bounds.x,m.bounds.y,m.bounds.width,m.bounds.height).is_some() && m.bounds.width<=16384. && m.bounds.height<=16384. && m.windows.len()<=4096 && m.windows.iter().all(|w|w.id!=0 && w.pid>0 && Rect::new(w.bounds.x,w.bounds.y,w.bounds.width,w.bounds.height).is_some()) && m.windows.iter().any(|w| w.id==target.window_id && w.pid==p.pid && w.bounds==r && w.layer==0))
        && target.window_id != 0 && p.pid > 0 && !p.bundle_id.is_empty() && p.bundle_id.len() <= 255
        && p.bundle_id.bytes().all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
        && f64::from_bits(p.launch_time_bits).is_finite()
        && Rect::new(r.x, r.y, r.width, r.height).is_some()
        && r.x.abs() <= 1_000_000.
        && r.y.abs() <= 1_000_000.
        && r.width <= 16384. && r.height <= 16384.
        && request.generation != 0 && !request.timeout.is_zero() && request.timeout <= MAX_REQUEST_AGE
        // Mandatory secret/card/code protection cannot be disabled at this native boundary.
        && request.rules.cards && request.rules.secrets && request.rules.codes
}

/// Conservative display privacy: only the authorized target's window rectangle survives,
/// with every other visible context covered even where it overlaps that rectangle. Round
/// every mask outwards, including fractional Quartz points on mixed-scale displays.
fn monitor_masks(
    request: &Request,
    width: u32,
    height: u32,
) -> Result<Vec<crate::screen::privacy::redact::PixelRect>, Error> {
    use crate::screen::privacy::redact::PixelRect;
    let Some(m) = &request.monitor else {
        return Ok(Vec::new());
    };
    let area = m.bounds;
    let safe = request.target.quartz_points;
    let clip = |r: Rect| -> Option<PixelRect> {
        let left = (((r.x - area.x) / area.width) * f64::from(width))
            .floor()
            .clamp(0., f64::from(width)) as u32;
        let top = (((r.y - area.y) / area.height) * f64::from(height))
            .floor()
            .clamp(0., f64::from(height)) as u32;
        let right = (((r.x + r.width - area.x) / area.width) * f64::from(width))
            .ceil()
            .clamp(0., f64::from(width)) as u32;
        let bottom = (((r.y + r.height - area.y) / area.height) * f64::from(height))
            .ceil()
            .clamp(0., f64::from(height)) as u32;
        (left < right && top < bottom).then_some(PixelRect {
            left,
            top,
            right,
            bottom,
        })
    };
    // The retained area is rounded INWARDS. Fractional edge pixels may mix an unsafe
    // background with the target and therefore belong to the surrounding blackout.
    let left = (((safe.x - area.x) / area.width) * f64::from(width))
        .ceil()
        .clamp(0., f64::from(width)) as u32;
    let top = (((safe.y - area.y) / area.height) * f64::from(height))
        .ceil()
        .clamp(0., f64::from(height)) as u32;
    let right = (((safe.x + safe.width - area.x) / area.width) * f64::from(width))
        .floor()
        .clamp(0., f64::from(width)) as u32;
    let bottom = (((safe.y + safe.height - area.y) / area.height) * f64::from(height))
        .floor()
        .clamp(0., f64::from(height)) as u32;
    if left >= right || top >= bottom {
        return Err(Error::InvalidFrame);
    }
    let mut masks = vec![
        PixelRect {
            left: 0,
            top: 0,
            right: width,
            bottom: top,
        },
        PixelRect {
            left: 0,
            top: bottom,
            right: width,
            bottom: height,
        },
        PixelRect {
            left: 0,
            top,
            right: left,
            bottom,
        },
        PixelRect {
            left: right,
            top,
            right: width,
            bottom,
        },
    ];
    masks.retain(|r| r.left < r.right && r.top < r.bottom);
    masks.extend(
        m.windows
            .iter()
            .take_while(|w| w.id != request.target.window_id)
            .filter_map(|w| clip(w.bounds)),
    );
    Ok(masks)
}

fn valid_frame(pixels: &Pixels) -> bool {
    pixels.width > 0
        && pixels.height > 0
        && pixels.width <= 16384
        && pixels.height <= 16384
        && pixels.channels == 4
        && (pixels.width as usize)
            .checked_mul(pixels.height as usize)
            .and_then(|n| n.checked_mul(4))
            .is_some_and(|n| n <= MAX_RAW_BYTES && n == pixels.data.len())
}

/// Owned OCR strings are secrets too; wipe their allocations when the transient lines drop.
struct SecretOcr(Vec<OcrLine>);
impl Drop for SecretOcr {
    fn drop(&mut self) {
        for word in self.0.iter_mut().flat_map(|line| &mut line.words) {
            // SAFETY: zero is valid UTF-8, and these strings are exclusively owned here.
            unsafe {
                wipe(word.text.as_bytes_mut());
            }
        }
    }
}
fn valid_ocr(lines: &[OcrLine], width: u32, height: u32) -> bool {
    if lines.len() > 8192 {
        return false;
    }
    let mut words = 0usize;
    let mut bytes = 0usize;
    lines.iter().flat_map(|line| &line.words).all(|word| {
        words += 1;
        bytes = bytes.saturating_add(word.text.len());
        words <= 32768
            && bytes <= MAX_OCR_TEXT
            && [
                word.x,
                word.y,
                word.width,
                word.height,
                word.x + word.width,
                word.y + word.height,
            ]
            .iter()
            .all(|v| v.is_finite())
            && !word.text.is_empty()
            && word.x >= 0.
            && word.y >= 0.
            && word.width > 0.
            && word.height > 0.
            && word.x + word.width <= width as f32
            && word.y + word.height <= height as f32
    })
}

/// Run on a worker. The sampler dispatches only bounded metadata work to the main queue; do
/// not invoke this on the main queue and then synchronously dispatch back to it. All failure
/// paths drop owned SecretBytes/ScreenText/SecretOcr before returning an error. No automatic
/// retry can capture a changed target; the user must issue a new request.
pub fn run<S, F>(
    service: &mut S,
    request: &Request,
    generation: &AtomicU64,
    sampler: &mut F,
) -> Result<Captured, Error>
where
    S: Service,
    F: FnMut(&Request, Checkpoint) -> Result<PolicyProof, Error>,
{
    if !valid_request(request) {
        return Err(Error::InvalidRequest);
    }
    let mut gate = Gate {
        request,
        generation,
        sampler,
        last_serial: None,
        require_indicator: true,
    };
    gate.check(Checkpoint::BeforeCapture)?;
    let mut guard_error = None;
    let captured = service.capture(&request.target, request.monitor.as_ref(), &mut || {
        // Once denied, this acquisition cannot become authorized by a later callback.
        if guard_error.is_some() {
            return false;
        }
        match gate.check(Checkpoint::NativeBoundary) {
            Ok(()) => true,
            Err(error) => {
                guard_error = Some(error);
                false
            }
        }
    });
    if let Some(error) = guard_error {
        return Err(error);
    }
    let mut pixels = captured.map_err(Error::Native)?;
    gate.check(Checkpoint::AfterCapture)?;
    if !valid_frame(&pixels) {
        return Err(Error::InvalidFrame);
    }
    if image::looks_blank(&pixels) {
        return Err(Error::BlankFrame);
    }
    let captured_size = (pixels.width, pixels.height);
    let blacked_out = monitor_masks(request, pixels.width, pixels.height)?;
    crate::screen::privacy::redact::fill(
        &mut pixels,
        &blacked_out,
        crate::screen::privacy::redact::BLACKED_OUT,
    );
    if image::looks_blank(&pixels) {
        return Err(Error::BlankFrame);
    }
    // Native OCR has a hard 2560-side input cap. Retain full-resolution pixels for masks,
    // reading a bounded grey copy and mapping local OCR geometry back into that image.
    let ocr_pixels = image::downscale_bgra_to_gray(&pixels, 2560);
    let lines = SecretOcr(service.recognize(&ocr_pixels).map_err(Error::Native)?);
    gate.check(Checkpoint::AfterOcr)?;
    if !valid_ocr(&lines.0, ocr_pixels.width, ocr_pixels.height) {
        return Err(Error::InvalidOcr);
    }
    let local = ScreenRect {
        left: 0,
        top: 0,
        right: pixels.width as i32,
        bottom: pixels.height as i32,
    };
    let text = ScreenText::redact_ocr(
        &mut pixels,
        &lines.0,
        (ocr_pixels.width, ocr_pixels.height),
        local,
        blacked_out.clone(),
        &request.rules,
    )
    .ok_or(Error::InvalidOcr)?;
    drop(lines);
    drop(ocr_pixels);
    gate.check(Checkpoint::AfterRedaction)?;
    let encoded_pixels = image::downscale_bgra_to_bgr(&pixels, image::MAX_LONG_SIDE);
    gate.check(Checkpoint::BeforeEncode)?;
    let jpeg = service.encode(&encoded_pixels).map_err(Error::Native)?;
    let encoded_size = (encoded_pixels.width, encoded_pixels.height);
    drop(encoded_pixels);
    if jpeg.len() < 4
        || jpeg.len() > MAX_JPEG_BYTES
        || !jpeg.as_slice().starts_with(&[0xff, 0xd8])
        || !jpeg.as_slice().ends_with(&[0xff, 0xd9])
    {
        return Err(Error::InvalidEncoding);
    }
    gate.check(Checkpoint::BeforeDelivery)?;
    gate.live()?;
    Ok(Captured {
        jpeg,
        pixels,
        blacked_out,
        text: LocalText(text),
        metadata: Metadata {
            quartz_points: request
                .monitor
                .as_ref()
                .map(|m| m.bounds)
                .unwrap_or(request.target.quartz_points),
            captured_pixels: captured_size,
            encoded_pixels: encoded_size,
            generation: request.generation,
            intent: request.intent,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::privacy::redact::OcrWord;
    use std::{cell::RefCell, rc::Rc, sync::Arc};

    type Events = Rc<RefCell<Vec<&'static str>>>;
    fn request() -> Request {
        Request {
            target: Target {
                window_id: 99,
                process: ProcessIdentity {
                    pid: 42,
                    bundle_id: "org.example.Fixture".into(),
                    launch_time_bits: 1000f64.to_bits(),
                },
                quartz_points: Rect::new(-300., 200., 50., 20.).unwrap(),
            },
            monitor: None,
            intent: Intent::Ask,
            generation: 7,
            issued_at: Instant::now(),
            timeout: Duration::from_secs(10),
            rules: RedactionRules::default(),
            pause_during_calls: true,
        }
    }
    /// Test-only positive evidence. Production has no permissive sampler.
    fn proof(request: &Request, serial: u64) -> PolicyProof {
        PolicyProof {
            monitor: request.monitor.clone(),
            sampled_at: Instant::now(),
            sampled_on_main_queue: true,
            serial,
            target: request.target.clone(),
            intent: request.intent,
            generation: request.generation,
            opted_in: true,
            paused: false,
            screen_permission: true,
            accessibility_permission: true,
            indicator_presented: true,
            focus: Focus::Ordinary,
            blocked_application: Evidence::Clear,
            private_browsing: Evidence::Clear,
            call_or_share: Evidence::Clear,
            pause_during_calls: request.pause_during_calls,
        }
    }
    struct Fake {
        events: Events,
        ocr_error: bool,
        malformed_ocr: bool,
        malformed_frame: bool,
        malformed_jpeg: bool,
        must_mask: bool,
        cancel_encode: Option<Arc<AtomicU64>>,
    }
    impl Fake {
        fn new(events: &Events) -> Self {
            Self {
                events: events.clone(),
                ocr_error: false,
                malformed_ocr: false,
                malformed_frame: false,
                malformed_jpeg: false,
                must_mask: true,
                cancel_encode: None,
            }
        }
    }
    impl Service for Fake {
        fn capture(
            &mut self,
            _: &Target,
            _: Option<&Monitor>,
            guard: &mut dyn FnMut() -> bool,
        ) -> Result<Pixels, capture::Error> {
            self.events.borrow_mut().push("capture");
            if !guard() || !guard() {
                return Err(capture::Error::Cancelled);
            }
            Ok(Pixels {
                width: 100,
                height: 40,
                channels: 4,
                data: SecretBytes::from_vec(vec![
                    255;
                    if self.malformed_frame {
                        1
                    } else {
                        100 * 40 * 4
                    }
                ]),
            })
        }
        fn recognize(&mut self, pixels: &Pixels) -> Result<Vec<OcrLine>, capture::Error> {
            self.events.borrow_mut().push("ocr");
            assert_eq!((pixels.width, pixels.height, pixels.channels), (100, 40, 1));
            if self.ocr_error {
                return Err(capture::Error::Native);
            }
            Ok(vec![OcrLine {
                words: vec![
                    OcrWord {
                        text: "4111111111111111".into(),
                        x: if self.malformed_ocr { f32::NAN } else { 20. },
                        y: 10.,
                        width: 40.,
                        height: 10.,
                    },
                    OcrWord {
                        text: "hello".into(),
                        x: 75.,
                        y: 10.,
                        width: 15.,
                        height: 10.,
                    },
                ],
            }])
        }
        fn encode(&mut self, pixels: &Pixels) -> Result<SecretBytes, capture::Error> {
            self.events.borrow_mut().push("encode");
            assert_eq!((pixels.width, pixels.height, pixels.channels), (100, 40, 3));
            if self.must_mask {
                for y in 10..20 {
                    for x in 20..60 {
                        let at = (y * 100 + x) * 3;
                        assert_eq!(&pixels.data.as_slice()[at..at + 3], &[128, 128, 128]);
                    }
                }
            }
            if let Some(generation) = &self.cancel_encode {
                generation.store(8, Ordering::SeqCst);
            }
            Ok(SecretBytes::from_vec(if self.malformed_jpeg {
                vec![1, 2, 3, 4]
            } else {
                vec![0xff, 0xd8, 1, 0xff, 0xd9]
            }))
        }
    }
    fn stage_name(stage: Checkpoint) -> &'static str {
        match stage {
            Checkpoint::BeforeCapture => "before",
            Checkpoint::NativeBoundary => "native",
            Checkpoint::AfterCapture => "after_capture",
            Checkpoint::AfterOcr => "after_ocr",
            Checkpoint::AfterRedaction => "after_redaction",
            Checkpoint::BeforeEncode => "before_encode",
            Checkpoint::BeforeDelivery => "delivery",
        }
    }

    #[test]
    fn redacts_secret_before_encoder_and_preserves_explicit_coordinate_spaces() {
        let events = Events::default();
        let mut fake = Fake::new(&events);
        let req = request();
        let generation = AtomicU64::new(7);
        let mut serial = 0;
        let out = run(&mut fake, &req, &generation, &mut |req, stage| {
            events.borrow_mut().push(stage_name(stage));
            serial += 1;
            Ok(proof(req, serial))
        })
        .unwrap();
        assert_eq!(
            *events.borrow(),
            vec![
                "before",
                "capture",
                "native",
                "native",
                "after_capture",
                "ocr",
                "after_ocr",
                "after_redaction",
                "before_encode",
                "encode",
                "delivery"
            ]
        );
        assert_eq!(out.metadata.quartz_points.x, -300.);
        assert_eq!(out.metadata.quartz_points.width, 50.);
        assert_eq!(out.metadata.captured_pixels, (100, 40));
        assert_eq!(out.metadata.encoded_pixels, (100, 40));
        let boxes: Vec<_> = out.text.image_pixel_boxes().collect();
        assert_eq!(boxes.len(), 1); // secret text never retained
        assert!(boxes[0].left >= 70 && boxes[0].right <= 100);
    }

    #[test]
    fn every_unsafe_or_unknown_policy_refuses_before_pixels() {
        for variant in 0..15 {
            let events = Events::default();
            let mut fake = Fake::new(&events);
            let req = request();
            let result = run(&mut fake, &req, &AtomicU64::new(7), &mut |req, _| {
                let mut p = proof(req, 1);
                match variant {
                    0 => p.focus = Focus::Unknown,
                    1 => p.focus = Focus::Password,
                    2 => p.private_browsing = Evidence::Unknown,
                    3 => p.private_browsing = Evidence::Present,
                    4 => p.call_or_share = Evidence::Unknown,
                    5 => p.call_or_share = Evidence::Present,
                    6 => p.blocked_application = Evidence::Unknown,
                    7 => p.blocked_application = Evidence::Present,
                    8 => p.indicator_presented = false,
                    9 => p.opted_in = false,
                    10 => p.paused = true,
                    11 => p.screen_permission = false,
                    12 => p.accessibility_permission = false,
                    13 => p.sampled_on_main_queue = false,
                    _ => return Err(Error::PolicyUnavailable),
                }
                Ok(p)
            });
            assert!(result.is_err(), "variant {variant}");
            assert!(events.borrow().is_empty(), "variant {variant}");
        }
    }

    #[test]
    fn target_launch_bounds_intent_and_generation_are_all_bound() {
        for variant in 0..7 {
            let events = Events::default();
            let mut fake = Fake::new(&events);
            let result = run(&mut fake, &request(), &AtomicU64::new(7), &mut |req, _| {
                let mut p = proof(req, 1);
                match variant {
                    0 => p.target.process.pid += 1,
                    1 => p.target.process.launch_time_bits = 2000f64.to_bits(),
                    2 => p.target.process.bundle_id = "org.example.Other".into(),
                    3 => p.target.window_id += 1,
                    4 => p.target.quartz_points.x += 1.,
                    5 => p.intent = Intent::Clip,
                    _ => p.generation += 1,
                }
                Ok(p)
            });
            assert!(matches!(result, Err(Error::StalePolicy)));
            assert!(events.borrow().is_empty());
        }
    }

    #[test]
    fn replayed_or_old_policy_proof_is_rejected() {
        let events = Events::default();
        let mut fake = Fake::new(&events);
        let req = request();
        let result = run(&mut fake, &req, &AtomicU64::new(7), &mut |req, _| {
            Ok(proof(req, 1))
        });
        assert!(matches!(result, Err(Error::StalePolicy))); // native second serial cannot replay
        assert!(!events.borrow().contains(&"ocr"));
        let old = proof(&req, 1);
        let result = run(&mut fake, &req, &AtomicU64::new(7), &mut |_, _| {
            Ok(old.clone())
        });
        assert!(matches!(result, Err(Error::StalePolicy)));
    }

    #[test]
    fn cancelling_at_each_boundary_prevents_delivery_and_later_work() {
        for stop in [
            Checkpoint::BeforeCapture,
            Checkpoint::NativeBoundary,
            Checkpoint::AfterCapture,
            Checkpoint::AfterOcr,
            Checkpoint::AfterRedaction,
            Checkpoint::BeforeEncode,
            Checkpoint::BeforeDelivery,
        ] {
            let events = Events::default();
            let mut fake = Fake::new(&events);
            let generation = AtomicU64::new(7);
            let mut serial = 0;
            let result = run(&mut fake, &request(), &generation, &mut |req, stage| {
                serial += 1;
                if stage == stop {
                    generation.store(8, Ordering::SeqCst);
                }
                Ok(proof(req, serial))
            });
            assert!(matches!(result, Err(Error::Cancelled)), "{stop:?}");
            if stop != Checkpoint::BeforeDelivery {
                assert!(!events.borrow().contains(&"encode"));
            }
        }
    }

    #[test]
    fn cancellation_inside_encoder_discards_completed_jpeg() {
        let events = Events::default();
        let mut fake = Fake::new(&events);
        let generation = Arc::new(AtomicU64::new(7));
        fake.cancel_encode = Some(generation.clone());
        let mut serial = 0;
        let result = run(&mut fake, &request(), &generation, &mut |req, _| {
            serial += 1;
            Ok(proof(req, serial))
        });
        assert!(matches!(result, Err(Error::Cancelled)));
        assert!(events.borrow().contains(&"encode"));
    }

    #[test]
    fn privacy_permission_and_indicator_revocation_after_ocr_cannot_deliver() {
        for stage_to_deny in [Checkpoint::AfterOcr, Checkpoint::BeforeDelivery] {
            for variant in 0..5 {
                let events = Events::default();
                let mut fake = Fake::new(&events);
                let mut serial = 0;
                let result = run(
                    &mut fake,
                    &request(),
                    &AtomicU64::new(7),
                    &mut |req, stage| {
                        serial += 1;
                        let mut p = proof(req, serial);
                        if stage == stage_to_deny {
                            match variant {
                                0 => p.private_browsing = Evidence::Unknown,
                                1 => p.call_or_share = Evidence::Present,
                                2 => p.focus = Focus::Password,
                                3 => p.screen_permission = false,
                                _ => p.indicator_presented = false,
                            }
                        }
                        Ok(p)
                    },
                );
                assert!(result.is_err());
                if stage_to_deny == Checkpoint::AfterOcr {
                    assert!(!events.borrow().contains(&"encode"));
                }
            }
        }
    }

    #[test]
    fn ocr_failure_or_invalid_geometry_never_reaches_encoder() {
        for malformed in [false, true] {
            let events = Events::default();
            let mut fake = Fake::new(&events);
            fake.ocr_error = !malformed;
            fake.malformed_ocr = malformed;
            let mut serial = 0;
            let result = run(&mut fake, &request(), &AtomicU64::new(7), &mut |req, _| {
                serial += 1;
                Ok(proof(req, serial))
            });
            assert!(result.is_err());
            assert!(!events.borrow().contains(&"encode"));
        }
    }

    #[test]
    fn malformed_frames_and_jpegs_are_rejected() {
        for frame in [false, true] {
            let events = Events::default();
            let mut fake = Fake::new(&events);
            fake.malformed_frame = frame;
            fake.malformed_jpeg = !frame;
            let mut serial = 0;
            let result = run(&mut fake, &request(), &AtomicU64::new(7), &mut |req, _| {
                serial += 1;
                Ok(proof(req, serial))
            });
            assert!(matches!(
                result,
                Err(Error::InvalidFrame | Error::InvalidEncoding)
            ));
            if frame {
                assert!(!events.borrow().contains(&"ocr"));
            }
        }
    }

    #[test]
    fn invalid_or_expired_request_never_calls_native_service() {
        for variant in 0..7 {
            let mut req = request();
            match variant {
                0 => req.rules.secrets = false,
                1 => req.timeout = Duration::from_secs(16),
                2 => req.target.quartz_points.width = f64::NAN,
                3 => req.target.process.launch_time_bits = f64::NAN.to_bits(),
                4 => req.issued_at = Instant::now() + Duration::from_secs(1),
                5 => req.issued_at = Instant::now() - Duration::from_secs(12),
                _ => req.target.process.bundle_id.clear(),
            }
            let events = Events::default();
            let mut fake = Fake::new(&events);
            let result = run(&mut fake, &req, &AtomicU64::new(7), &mut |_, _| {
                panic!("must not sample")
            });
            assert!(matches!(
                result,
                Err(Error::InvalidRequest | Error::Timeout)
            ));
            assert!(events.borrow().is_empty());
        }
    }
    #[test]
    fn retained_full_resolution_pixels_are_redacted_before_clip_use() {
        let events = Events::default();
        let mut fake = Fake::new(&events);
        let mut serial = 0;
        let out = run(&mut fake, &request(), &AtomicU64::new(7), &mut |r, _| {
            serial += 1;
            Ok(proof(r, serial))
        })
        .unwrap();
        assert_eq!(
            (out.pixels.width, out.pixels.height, out.pixels.channels),
            (100, 40, 4)
        );
        for y in 10..20 {
            for x in 20..60 {
                let at = (y * 100 + x) * 4;
                assert_eq!(&out.pixels.data.as_slice()[at..at + 3], &[128, 128, 128]);
            }
        }
    }
    #[test]
    fn call_setting_and_evidence_are_bound_at_every_boundary() {
        for enabled in [true, false] {
            for evidence in [
                Evidence::KnownSignalsIdle,
                Evidence::DisabledByLocalPolicy,
                Evidence::Present,
                Evidence::Unknown,
            ] {
                let mut request = request();
                request.pause_during_calls = enabled;
                let events = Events::default();
                let mut fake = Fake::new(&events);
                let mut serial = 0;
                let result = run(&mut fake, &request, &AtomicU64::new(7), &mut |r, _| {
                    serial += 1;
                    let mut p = proof(r, serial);
                    p.call_or_share = evidence;
                    Ok(p)
                });
                assert_eq!(
                    result.is_ok(),
                    matches!(
                        (enabled, evidence),
                        (true, Evidence::KnownSignalsIdle)
                            | (false, Evidence::DisabledByLocalPolicy)
                    )
                );
            }
        }
        let request = request();
        let mut p = proof(&request, 1);
        p.pause_during_calls = false;
        assert!(matches!(
            revalidate_metadata(&request, &AtomicU64::new(7), &mut |_, _| Ok(p.clone())),
            Err(Error::StalePolicy)
        ));
    }
    #[test]
    fn metadata_only_revalidation_cannot_substitute_for_pixel_indicator() {
        let request = request();
        let generation = AtomicU64::new(7);
        assert!(revalidate_metadata(&request, &generation, &mut |r, _| {
            let mut p = proof(r, 1);
            p.indicator_presented = false;
            Ok(p)
        })
        .is_ok());
        let events = Events::default();
        let mut fake = Fake::new(&events);
        assert!(matches!(
            run(&mut fake, &request, &generation, &mut |r, _| {
                let mut p = proof(r, 1);
                p.indicator_presented = false;
                Ok(p)
            }),
            Err(Error::IndicatorUnavailable)
        ));
        assert!(events.borrow().is_empty());
    }
    fn monitor_request() -> Request {
        let mut r = request();
        r.monitor = Some(Monitor {
            id: 1,
            bounds: Rect::new(-350., 180., 100., 50.).unwrap(),
            windows: vec![
                VisibleWindow {
                    id: 10,
                    pid: 43,
                    bounds: Rect::new(-290., 205., 10., 5.).unwrap(),
                    layer: 1,
                },
                VisibleWindow {
                    id: r.target.window_id,
                    pid: r.target.process.pid,
                    bounds: r.target.quartz_points,
                    layer: 0,
                },
                VisibleWindow {
                    id: 11,
                    pid: 44,
                    bounds: Rect::new(-350., 180., 100., 50.).unwrap(),
                    layer: 0,
                },
            ],
        });
        r
    }
    #[test]
    fn monitor_masks_all_outside_context_and_front_occluders_before_ocr() {
        let req = monitor_request();
        let masks = monitor_masks(&req, 200, 100).unwrap();
        let covered = |x, y| {
            masks
                .iter()
                .any(|r| x >= r.left && x < r.right && y >= r.top && y < r.bottom)
        };
        assert!(covered(0, 0));
        assert!(covered(100, 39));
        assert!(covered(120, 50));
        assert!(
            !covered(150, 60),
            "background window behind target cannot black opaque safe capture pixels"
        );
        let events = Events::default();
        let mut fake = Fake::new(&events);
        fake.must_mask = false;
        let mut serial = 0;
        let frame = run(&mut fake, &req, &AtomicU64::new(7), &mut |r, _| {
            serial += 1;
            Ok(proof(r, serial))
        })
        .unwrap();
        assert!(!frame.blacked_out.is_empty());
        assert_eq!(frame.metadata.quartz_points, req.monitor.unwrap().bounds);
        assert_eq!(&frame.pixels.data.as_slice()[..4], &[0, 0, 0, 255]);
    }
    #[test]
    fn monitor_inventory_reordering_replacement_or_geometry_race_never_delivers() {
        for stage in [
            Checkpoint::NativeBoundary,
            Checkpoint::AfterCapture,
            Checkpoint::AfterOcr,
            Checkpoint::BeforeDelivery,
        ] {
            for change in 0..3 {
                let events = Events::default();
                let mut fake = Fake::new(&events);
                fake.must_mask = false;
                let mut serial = 0;
                let result = run(
                    &mut fake,
                    &monitor_request(),
                    &AtomicU64::new(7),
                    &mut |r, s| {
                        serial += 1;
                        let mut p = proof(r, serial);
                        if s == stage {
                            let m = p.monitor.as_mut().unwrap();
                            match change {
                                0 => m.windows.reverse(),
                                1 => m.windows[0].id += 1,
                                _ => m.windows[0].bounds.x += 0.5,
                            }
                        }
                        Ok(p)
                    },
                );
                assert!(
                    matches!(result, Err(Error::StalePolicy)),
                    "{stage:?} {change}"
                );
            }
        }
    }
    #[test]
    fn monitor_composition_never_reads_background_and_keeps_black_transparency() {
        let source = Pixels {
            width: 4,
            height: 2,
            channels: 4,
            data: SecretBytes::from_vec(vec![
                20, 30, 40, 255, 0, 0, 0, 0, 20, 30, 40, 255, 20, 30, 40, 255, 20, 30, 40, 255, 20,
                30, 40, 255, 20, 30, 40, 255, 20, 30, 40, 255,
            ]),
        };
        let output = compose_monitor(
            source,
            Rect::new(-8., -1., 2., 1.).unwrap(),
            Rect::new(-10., -2., 10., 5.).unwrap(),
        )
        .unwrap();
        assert_eq!((output.width, output.height), (20, 10));
        assert_eq!(&output.data.as_slice()[..4], &[0, 0, 0, 255]);
        let at = (2 * 20 + 4) * 4;
        assert_eq!(&output.data.as_slice()[at..at + 4], &[20, 30, 40, 255]);
        assert_eq!(&output.data.as_slice()[at + 4..at + 8], &[0, 0, 0, 255]);
    }
}
