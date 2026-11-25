//! One explicit, in-process Mac capture. This module has no IPC, files, provider or permission
//! request path. Production callers must supply a bounded main-queue policy sampler; the
//! current AX adapter's Unknown private/call/share evidence MUST remain Unknown and refuses.
//! A sampler is a trusted native boundary, not data accepted from a webview. No default sampler
//! manufactures authorization. Display capture is deliberately unsupported until all visible
//! window privacy/blackout evidence can be established.
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
const MAX_SAMPLE_TIME: Duration = Duration::from_millis(500);
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

pub struct Request {
    pub target: Target,
    pub intent: Intent,
    /// Increment the shared generation on disable, pause, cancellation, or a new intent.
    pub generation: u64,
    pub issued_at: Instant,
    pub timeout: Duration,
    pub rules: RedactionRules,
}

/// Positive absence evidence must come from an appropriate trusted native source. Absence of
/// metadata or permission is Unknown, not Clear. In particular AX ordinary focus proves
/// neither private-window absence nor call/share absence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Evidence {
    Clear,
    Present,
    Unknown,
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
        guard: &mut dyn FnMut() -> bool,
    ) -> Result<Pixels, capture::Error> {
        capture::capture(
            capture::Target::Window {
                id: target.window_id,
                pid: target.process.pid,
                bounds: target.quartz_points,
            },
            guard,
        )
    }
    fn recognize(&mut self, pixels: &Pixels) -> Result<Vec<OcrLine>, capture::Error> {
        capture::recognize(pixels)
    }
    fn encode(&mut self, redacted: &Pixels) -> Result<SecretBytes, capture::Error> {
        capture::encode_jpeg(redacted, 0.8)
    }
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
    pub text: LocalText,
    pub metadata: Metadata,
}

struct Gate<'a, F> {
    request: &'a Request,
    generation: &'a AtomicU64,
    sampler: &'a mut F,
    last_serial: Option<u64>,
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
        if proof.target != self.request.target
            || proof.intent != self.request.intent
            || proof.generation != self.request.generation
        {
            return Err(Error::StalePolicy);
        }
        if !proof.opted_in || proof.paused {
            return Err(Error::Cancelled);
        }
        if !proof.screen_permission || !proof.accessibility_permission {
            return Err(Error::Permission);
        }
        if !proof.indicator_presented {
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
            (proof.call_or_share, Error::CallOrShare),
        ] {
            match evidence {
                Evidence::Clear => {}
                Evidence::Present => return Err(refusal),
                Evidence::Unknown => return Err(Error::UnknownPrivacy),
            }
        }
        Ok(())
    }
}

fn valid_request(request: &Request) -> bool {
    let target = &request.target;
    let p = &target.process;
    let r = target.quartz_points;
    target.window_id != 0 && p.pid > 0 && !p.bundle_id.is_empty() && p.bundle_id.len() <= 255
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
    };
    gate.check(Checkpoint::BeforeCapture)?;
    let mut guard_error = None;
    let captured = service.capture(&request.target, &mut || {
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
        Vec::new(),
        &request.rules,
    )
    .ok_or(Error::InvalidOcr)?;
    drop(lines);
    drop(ocr_pixels);
    gate.check(Checkpoint::AfterRedaction)?;
    let encoded_pixels = image::downscale_bgra_to_bgr(&pixels, image::MAX_LONG_SIDE);
    drop(pixels);
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
        text: LocalText(text),
        metadata: Metadata {
            quartz_points: request.target.quartz_points,
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
            intent: Intent::Ask,
            generation: 7,
            issued_at: Instant::now(),
            timeout: Duration::from_secs(10),
            rules: RedactionRules::default(),
        }
    }
    /// Test-only positive evidence. Production has no permissive sampler.
    fn proof(request: &Request, serial: u64) -> PolicyProof {
        PolicyProof {
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
}
