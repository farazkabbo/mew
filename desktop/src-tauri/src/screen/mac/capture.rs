//! Bounded, in-memory Apple SDK bridge. Only the native worker uses this module; no IPC returns
//! pixels or OCR. A capture's caller must supply a current privacy/intent/indicator guard.
use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};

use serde::Deserialize;

use super::target::Rect;
use crate::screen::image::Pixels;
use crate::screen::privacy::redact::{OcrLine, OcrWord};
use crate::screen::secret::{wipe, SecretBytes};

const MAX_PIXELS_BYTES: usize = 128 * 1024 * 1024;
const MAX_JPEG_BYTES: usize = 16 * 1024 * 1024;
const MAX_OCR_BYTES: usize = 4 * 1024 * 1024;

type BytesCallback = extern "C" fn(*mut c_void, *const u8, usize, u32, u32, u32);
type GuardCallback = extern "C" fn(*mut c_void) -> i32;

unsafe extern "C" {
    fn neb_capture_permission() -> i32;
    fn neb_capture_once(
        kind: u32,
        id: u32,
        pid: i32,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        guard: GuardCallback,
        guard_context: *mut c_void,
        output: BytesCallback,
        output_context: *mut c_void,
    ) -> i32;
    fn neb_ocr_read(
        bytes: *const u8,
        len: usize,
        width: u32,
        height: u32,
        channels: u32,
        output: BytesCallback,
        output_context: *mut c_void,
    ) -> i32;
    fn neb_jpeg_encode(
        bytes: *const u8,
        len: usize,
        width: u32,
        height: u32,
        channels: u32,
        quality: f64,
        output: BytesCallback,
        output_context: *mut c_void,
    ) -> i32;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Invalid,
    Permission,
    ChangedTarget,
    Native,
    Timeout,
    Cancelled,
    Unsupported,
    Busy,
    TooLarge,
}
fn check(code: i32) -> Result<(), Error> {
    Err(match code {
        0 => return Ok(()),
        1 => Error::Invalid,
        2 => Error::Permission,
        3 => Error::ChangedTarget,
        5 => Error::Timeout,
        6 => Error::Cancelled,
        7 => Error::Unsupported,
        8 => Error::Busy,
        9 => Error::TooLarge,
        _ => Error::Native,
    })
}

/// Permission check only; no user consent dialog or system settings changes.
pub fn permission_granted() -> bool {
    unsafe { neb_capture_permission() == 1 }
}

/// Exact immutable target metadata captured before displaying Neb's own overlay.
/// This is not permission: the caller's guard must validate process launch identity, current
/// focus/privacy/cancellation, and that the capture indicator has actually been presented.
#[derive(Debug, Clone, Copy)]
pub enum Target {
    Window { id: u32, pid: i32, bounds: Rect },
    Display { id: u32, bounds: Rect },
}

struct Reply {
    bytes: Option<SecretBytes>,
    shape: (u32, u32, u32),
    limit: usize,
    raw: bool,
}
impl Reply {
    fn new(limit: usize, raw: bool) -> Self {
        Self {
            bytes: None,
            shape: (0, 0, 0),
            limit,
            raw,
        }
    }
    fn take(self) -> Result<SecretBytes, Error> {
        self.bytes.ok_or(Error::Native)
    }
}

extern "C" fn receive(
    context: *mut c_void,
    bytes: *const u8,
    length: usize,
    w: u32,
    h: u32,
    channels: u32,
) {
    // SAFETY: native/macos/neb_capture.h promises callbacks only during the synchronous call;
    // context points to its exclusively borrowed stack Reply and bytes to `length` valid bytes.
    let reply = unsafe { &mut *context.cast::<Reply>() };
    if reply.bytes.is_some() || bytes.is_null() || length == 0 || length > reply.limit {
        return;
    }
    if reply.raw && (channels != 4 || byte_count(w, h, channels) != Some(length)) {
        return;
    }
    let mut copy = Vec::new();
    if copy.try_reserve_exact(length).is_err() {
        return;
    }
    copy.extend_from_slice(unsafe { std::slice::from_raw_parts(bytes, length) });
    reply.shape = (w, h, channels);
    reply.bytes = Some(SecretBytes::from_vec(copy));
}

struct Guard<'a>(&'a mut dyn FnMut() -> bool);
extern "C" fn guard(context: *mut c_void) -> i32 {
    // SAFETY: borrowed until neb_capture_once returns, including its synchronous callbacks.
    let current = unsafe { &mut *context.cast::<Guard<'_>>() };
    i32::from(catch_unwind(AssertUnwindSafe(|| (current.0)())).unwrap_or(false))
}

/// Call on a worker thread. A cancelled/refused/changed frame is wiped before returning error.
/// No capture occurs without a guard returning true at every native acquisition boundary.
pub fn capture(target: Target, current: &mut dyn FnMut() -> bool) -> Result<Pixels, Error> {
    let (kind, id, pid, bounds) = match target {
        Target::Window { id, pid, bounds } if pid > 0 => (1, id, pid, bounds),
        Target::Display { id, bounds } => (2, id, 0, bounds),
        _ => return Err(Error::Invalid),
    };
    if id == 0 || Rect::new(bounds.x, bounds.y, bounds.width, bounds.height).is_none() {
        return Err(Error::Invalid);
    }
    let mut reply = Reply::new(MAX_PIXELS_BYTES, true);
    let mut bound = Guard(current);
    // SAFETY: the synchronous native call borrows both stack contexts and invokes them only
    // on this worker. Swift discards timed-out completion instead of calling stale contexts.
    check(unsafe {
        neb_capture_once(
            kind,
            id,
            pid,
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            guard,
            (&mut bound as *mut Guard<'_>).cast(),
            receive,
            (&mut reply as *mut Reply).cast(),
        )
    })?;
    if !(bound.0)() {
        return Err(Error::Cancelled);
    }
    let (width, height, channels) = reply.shape;
    Ok(Pixels {
        width,
        height,
        channels,
        data: reply.take()?,
    })
}

fn byte_count(w: u32, h: u32, channels: u32) -> Option<usize> {
    if w == 0 || h == 0 || w > 16384 || h > 16384 {
        return None;
    }
    (w as usize)
        .checked_mul(h as usize)?
        .checked_mul(channels as usize)
        .filter(|n| *n <= MAX_PIXELS_BYTES)
}
fn valid_input(pixels: &Pixels, allowed: &[u32]) -> bool {
    allowed.contains(&pixels.channels)
        && byte_count(pixels.width, pixels.height, pixels.channels)
            == Some(pixels.data.as_slice().len())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OcrReply {
    lines: Vec<RawLine>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawLine {
    words: Vec<RawWord>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawWord {
    text: OcrText,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

/// Own parsed OCR immediately, including while serde is constructing a partial reply.
/// Keep every string here until the entire reply validates; no partial OcrLine can escape.
#[derive(Deserialize)]
#[serde(transparent)]
struct OcrText(String);
impl Drop for OcrText {
    fn drop(&mut self) {
        // SAFETY: exclusive ownership; extending and overwriting with zero preserves UTF-8.
        unsafe {
            let bytes = self.0.as_mut_vec();
            bytes.resize(bytes.capacity(), 0);
            wipe(bytes);
            #[cfg(test)]
            {
                assert!(bytes.iter().all(|byte| *byte == 0));
                if !bytes.is_empty() {
                    WIPED_OCR_STRINGS.with(|count| count.set(count.get() + 1));
                }
            }
        }
    }
}
#[cfg(test)]
std::thread_local! {
    static WIPED_OCR_STRINGS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn decode_ocr(encoded: &[u8], width: u32, height: u32) -> Result<Vec<OcrLine>, Error> {
    let raw: OcrReply = serde_json::from_slice(encoded).map_err(|_| Error::Native)?;
    if raw.lines.len() > 8192 {
        return Err(Error::TooLarge);
    }
    let mut size = 0usize;
    // Validate by borrow first. Every failure drops ALL parsed text through OcrText,
    // including earlier valid lines and any fields in a partially deserialized RawWord.
    for line in &raw.lines {
        if line.words.len() != 1 {
            return Err(Error::Native);
        }
        for word in &line.words {
            size = size.checked_add(word.text.0.len()).ok_or(Error::TooLarge)?;
            if size > 2 * 1024 * 1024
                || ![word.x, word.y, word.width, word.height]
                    .iter()
                    .all(|v| v.is_finite())
                || word.x < 0.
                || word.y < 0.
                || word.width <= 0.
                || word.height <= 0.
                || word.x >= width as f32
                || word.y >= height as f32
            {
                return Err(Error::Native);
            }
        }
    }
    // No fallible validation remains. Move the same allocations into the successful
    // result, whose caller immediately assumes zeroizing ownership in SecretOcr.
    Ok(raw
        .lines
        .into_iter()
        .map(|line| OcrLine {
            words: line
                .words
                .into_iter()
                .map(|mut word| OcrWord {
                    width: word.width.min(width as f32 - word.x),
                    height: word.height.min(height as f32 - word.y),
                    text: std::mem::take(&mut word.text.0),
                    x: word.x,
                    y: word.y,
                })
                .collect(),
        })
        .collect())
}

pub fn recognize(pixels: &Pixels) -> Result<Vec<OcrLine>, Error> {
    if !valid_input(pixels, &[1, 4]) || pixels.width > 2560 || pixels.height > 2560 {
        return Err(Error::Invalid);
    }
    let mut reply = Reply::new(MAX_OCR_BYTES, false);
    // SAFETY: valid tightly-packed input remains borrowed and alive through the synchronous call.
    check(unsafe {
        neb_ocr_read(
            pixels.data.as_slice().as_ptr(),
            pixels.data.as_slice().len(),
            pixels.width,
            pixels.height,
            pixels.channels,
            receive,
            (&mut reply as *mut Reply).cast(),
        )
    })?;
    let encoded = reply.take()?;
    decode_ocr(encoded.as_slice(), pixels.width, pixels.height)
}

/// Encode only after the caller has run shared privacy/redaction and revalidated its guard.
pub fn encode_jpeg(redacted: &Pixels, quality: f64) -> Result<SecretBytes, Error> {
    if !valid_input(redacted, &[3, 4]) || !quality.is_finite() || !(0.0..=1.0).contains(&quality) {
        return Err(Error::Invalid);
    }
    let mut reply = Reply::new(MAX_JPEG_BYTES, false);
    // SAFETY: no input mutation or caller pointer retention; output copied before native wipe.
    check(unsafe {
        neb_jpeg_encode(
            redacted.data.as_slice().as_ptr(),
            redacted.data.as_slice().len(),
            redacted.width,
            redacted.height,
            redacted.channels,
            quality,
            receive,
            (&mut reply as *mut Reply).cast(),
        )
    })?;
    reply.take()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_second_line_wipes_all_parsed_text_before_returning() {
        let before = WIPED_OCR_STRINGS.with(|count| count.get());
        let encoded = br#"{"lines":[{"words":[{"text":"synthetic-secret-first","x":0,"y":0,"width":8,"height":8}]},{"words":[{"text":"synthetic-secret-second","x":100,"y":0,"width":8,"height":8}]}]}"#;
        assert!(matches!(decode_ocr(encoded, 32, 32), Err(Error::Native)));
        assert_eq!(WIPED_OCR_STRINGS.with(|count| count.get()) - before, 2);
    }

    #[test]
    fn incomplete_deserialization_also_wipes_earlier_owned_text() {
        let before = WIPED_OCR_STRINGS.with(|count| count.get());
        // The second word fails after its text has already been deserialized.
        let encoded = br#"{"lines":[{"words":[{"text":"synthetic-secret-first","x":0,"y":0,"width":8,"height":8}]},{"words":[{"text":"synthetic-secret-second","x":1}]}]}"#;
        assert!(matches!(decode_ocr(encoded, 32, 32), Err(Error::Native)));
        assert_eq!(WIPED_OCR_STRINGS.with(|count| count.get()) - before, 2);
    }

    #[test]
    fn refuses_invalid_pixel_lengths_and_quality_before_crossing_ffi() {
        let invalid = Pixels {
            width: 100,
            height: 100,
            channels: 4,
            data: SecretBytes::zeroed(1),
        };
        assert!(matches!(recognize(&invalid), Err(Error::Invalid)));
        assert!(matches!(encode_jpeg(&invalid, 0.8), Err(Error::Invalid)));
        assert!(byte_count(u32::MAX, u32::MAX, 4).is_none());
        let valid = Pixels {
            width: 2,
            height: 2,
            channels: 3,
            data: SecretBytes::zeroed(12),
        };
        assert!(matches!(encode_jpeg(&valid, f64::NAN), Err(Error::Invalid)));
    }
    #[test]
    fn encodes_a_synthetic_image_and_reads_a_blank_fixture_without_capture() {
        let redacted = Pixels {
            width: 32,
            height: 32,
            channels: 4,
            data: SecretBytes::zeroed(32 * 32 * 4),
        };
        let jpeg = encode_jpeg(&redacted, 0.8).unwrap();
        assert!(jpeg.as_slice().starts_with(&[0xff, 0xd8]));
        let blank = Pixels {
            width: 32,
            height: 32,
            channels: 1,
            data: SecretBytes::from_vec(vec![255; 32 * 32]),
        };
        assert!(recognize(&blank).unwrap().is_empty());
    }
    #[test]
    fn an_intent_guard_denial_never_acquires_pixels() {
        let target = Target::Display {
            id: 1,
            bounds: Rect::new(0., 0., 10., 10.).unwrap(),
        };
        assert!(matches!(
            capture(target, &mut || false),
            Err(Error::Cancelled)
        ));
    }
}
