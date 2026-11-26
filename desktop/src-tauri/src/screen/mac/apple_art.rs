//! Apple Music artwork from its installed public com.apple.Music.sdef. The only event
//! is core/getd to the already-running PID, with NeverInteract + DoNotPromptForUserConsent.
//! No files, automation prompt, app launch, network, private framework or player control.
use super::Track;
use crate::screen::{
    base64,
    mac::{handoff_crypto, privacy},
    music,
};
use std::{
    ffi::c_void,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};
use tauri::AppHandle;
const MAX_RAW: usize = 4 * 1024 * 1024;
#[repr(C, packed(2))]
struct Desc {
    kind: u32,
    data: *mut c_void,
}
#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn AECreateDesc(kind: u32, bytes: *const c_void, size: isize, out: *mut Desc) -> i16;
    fn AEDisposeDesc(desc: *mut Desc) -> i16;
    fn CreateObjSpecifier(
        class: u32,
        container: *mut Desc,
        form: u32,
        key: *mut Desc,
        dispose: u8,
        out: *mut Desc,
    ) -> i16;
    fn AECreateAppleEvent(
        class: u32,
        id: u32,
        target: *const Desc,
        return_id: i16,
        transaction: i32,
        out: *mut Desc,
    ) -> i16;
    fn AEPutParamDesc(event: *mut Desc, key: u32, value: *const Desc) -> i16;
    fn AESendMessage(event: *const Desc, reply: *mut Desc, mode: i32, timeout_ticks: isize) -> i32;
    fn AEGetParamDesc(reply: *const Desc, key: u32, kind: u32, out: *mut Desc) -> i16;
    fn AEGetDescDataSize(desc: *const Desc) -> isize;
    fn AEGetDescData(desc: *const Desc, bytes: *mut c_void, size: isize) -> i16;

}
const fn code(s: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*s)
}
const SEND_MODE: i32 = 3 | 0x10 | 0x00020000; // WaitReply | NeverInteract | DoNotPromptForUserConsent
struct Owned(Desc);
impl Owned {
    fn empty() -> Self {
        Self(Desc {
            kind: code(b"null"),
            data: std::ptr::null_mut(),
        })
    }
    fn create(kind: &[u8; 4], bytes: &[u8]) -> Option<Self> {
        let mut d = Self::empty();
        (unsafe {
            AECreateDesc(
                code(kind),
                bytes.as_ptr().cast(),
                bytes.len() as isize,
                &mut d.0,
            )
        } == 0)
            .then_some(d)
    }
    fn bytes(&self, max: usize) -> Option<Vec<u8>> {
        let size = usize::try_from(unsafe { AEGetDescDataSize(&self.0) }).ok()?;
        if size > max {
            return None;
        }
        let mut out = vec![0; size];
        (unsafe { AEGetDescData(&self.0, out.as_mut_ptr().cast(), size as isize) } == 0)
            .then_some(out)
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { AEDisposeDesc(&mut self.0) };
    }
}
fn spec(class: &[u8; 4], container: &mut Owned, form: &[u8; 4], key: &mut Owned) -> Option<Owned> {
    let mut d = Owned::empty();
    (unsafe {
        CreateObjSpecifier(
            code(class),
            &mut container.0,
            code(form),
            &mut key.0,
            0,
            &mut d.0,
        )
    } == 0)
        .then_some(d)
}
struct Query<'a> {
    address: Owned,
    current: &'a dyn Fn() -> bool,
    deadline: Instant,
}
impl Query<'_> {
    fn live(&self) -> bool {
        Instant::now() < self.deadline && (self.current)() && Instant::now() < self.deadline
    }
    fn get_object(&self, object: Owned, kind: &[u8; 4]) -> Option<Owned> {
        if !self.live() {
            return None;
        }
        let mut event = Owned::empty();
        let mut reply = Owned::empty();
        if unsafe {
            AECreateAppleEvent(
                code(b"core"),
                code(b"getd"),
                &self.address.0,
                -1,
                0,
                &mut event.0,
            )
        } != 0
        {
            return None;
        }
        if unsafe { AEPutParamDesc(&mut event.0, code(b"----"), &object.0) } != 0 {
            return None;
        }
        // Each read has at most 12 ticks (200ms). The outer bounded transaction checks its
        // deadline and cancellation before AND after; late replies cannot authorize anything.
        let ticks = (self
            .deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            * 60
            / 1000)
            .clamp(1, 12) as isize;
        if unsafe { AESendMessage(&event.0, &mut reply.0, SEND_MODE, ticks) } != 0 || !self.live() {
            return None;
        }
        let mut value = Owned::empty();
        (unsafe { AEGetParamDesc(&reply.0, code(b"----"), code(kind), &mut value.0) } == 0)
            .then_some(value)
    }
}

fn property(mut container: Owned, name: &[u8; 4]) -> Option<Owned> {
    let mut key = Owned::create(b"type", &code(name).to_ne_bytes())?;
    spec(b"prop", &mut container, b"prop", &mut key)
}
fn track() -> Option<Owned> {
    property(Owned::empty(), b"pTrk")
}
fn persistent_id(query: &Query<'_>) -> Option<String> {
    let value = query.get_object(property(track()?, b"pPIS")?, b"utf8")?;
    String::from_utf8(value.bytes(32)?).ok()
}
fn raw_art(query: &Query<'_>) -> Option<Vec<u8>> {
    let mut current = track()?;
    let mut index = Owned::create(b"long", &1i32.to_ne_bytes())?;
    let art = spec(b"cArt", &mut current, b"indx", &mut index)?;
    let raw = query.get_object(property(art, b"pRaw")?, b"****")?;
    // `raw data` is dictionary type `any`; only the public JPEG/PNG/raw-data descriptor
    // types with matching image signatures are decoded. PICT, lists and text refuse.
    let bytes = raw.bytes(MAX_RAW)?;
    supported_bytes(raw.0.kind, &bytes).then_some(bytes)
}
fn bound_art(
    expected: &str,
    read_id: &mut dyn FnMut() -> Option<String>,
    read_raw: &mut dyn FnMut() -> Option<Vec<u8>>,
) -> Option<Vec<u8>> {
    if read_id().as_deref() != Some(expected) {
        return None;
    }
    let bytes = read_raw()?;
    (read_id().as_deref() == Some(expected)).then_some(bytes)
}
fn supported_bytes(kind: u32, bytes: &[u8]) -> bool {
    bytes.len() <= MAX_RAW
        && matches!(kind, k if k == code(b"JPEG") || k == code(b"PNGf") || k == code(b"tdta"))
        && (bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.starts_with(&[0xff, 0xd8, 0xff]))
}
fn same_identity(bundle: &str, pid: i32, launch: f64, expected: &Track) -> bool {
    expected.app == "com.apple.Music"
        && bundle == expected.app
        && pid == expected.pid
        && pid > 0
        && launch.is_finite()
        && expected.launch.parse::<f64>().ok() == Some(launch)
}
/// AppKit identity checks stay on the main queue, while binary AppleEvents and decoding
/// run on the existing music worker. Cancellation/timeouts revoke queued checks too.
fn bound(app: &AppHandle, generation: u64, expected: &Track, deadline: Instant) -> bool {
    let live = Arc::new(AtomicBool::new(true));
    let active = live.clone();
    let handle = app.clone();
    let expected = expected.clone();
    let (tx, rx) = mpsc::sync_channel(1);
    let scheduled = app.run_on_main_thread(move || {
        if !active.load(Ordering::Acquire)
            || Instant::now() >= deadline
            || !super::is_current(&handle, generation)
        {
            return;
        }
        let result = privacy::process_identity(expected.pid).is_some_and(|p| {
            // The public NSDate reference epoch is 2001; JXA media identities use 1970.
            same_identity(
                &p.bundle_id,
                p.pid,
                f64::from_bits(p.launch_time_bits) + 978307200.,
                &expected,
            )
        });
        if active.load(Ordering::Acquire)
            && Instant::now() < deadline
            && super::is_current(&handle, generation)
        {
            let _ = tx.send(result);
        }
    });
    let result = scheduled.is_ok()
        && rx
            .recv_timeout(
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(200)),
            )
            .unwrap_or(false);
    live.store(false, Ordering::Release);
    result
}
/// An absent/large/unsupported artwork is optional metadata; it does not disable controls.
/// Read the stable track ID on both sides of the binary read and verify process launch on
/// both sides of the transaction. Any stale completion is discarded before publication.
pub(super) fn read(
    app: &AppHandle,
    generation: u64,
    expected: &Track,
    current: &dyn Fn() -> bool,
) -> Option<String> {
    if expected.app != "com.apple.Music"
        || expected.pid <= 0
        || expected.track.len() != 16
        || !expected.track.bytes().all(|b| b.is_ascii_hexdigit())
        || !current()
    {
        return None;
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    if !bound(app, generation, expected, deadline) || !current() {
        return None;
    }
    let query = Query {
        address: Owned::create(b"kpid", &expected.pid.to_ne_bytes())?,
        current,
        deadline,
    };
    let bytes = bound_art(&expected.track, &mut || persistent_id(&query), &mut || {
        raw_art(&query)
    })?;
    if !query.live() || !bound(app, generation, expected, deadline) {
        return None;
    }
    // The existing bridge uses ImageIO dimensions/decode checks and emits a bounded JPEG.
    let image = handoff_crypto::image(&bytes, None, 384)?;
    let mime = music::art_mime(image.as_slice())?;
    if persistent_id(&query).as_deref() != Some(expected.track.as_str())
        || !query.live()
        || !bound(app, generation, expected, deadline)
    {
        return None;
    }
    Some(format!(
        "data:{mime};base64,{}",
        base64::encode(image.as_slice())
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_abi_is_no_prompt_and_binary_output_has_fixed_bounds() {
        assert_eq!(std::mem::size_of::<Desc>(), 12);
        assert_eq!(std::mem::align_of::<Desc>(), 2);
        assert_eq!(SEND_MODE & 0x20000, 0x20000);
        assert_eq!(SEND_MODE & 0x30, 0x10);
        assert!(supported_bytes(code(b"JPEG"), &[0xff, 0xd8, 0xff, 0xe0]));
        assert!(supported_bytes(
            code(b"tdta"),
            b"\x89PNG\r\n\x1a\nsynthetic"
        ));
        for kind in [code(b"TEXT"), code(b"PICT"), code(b"list")] {
            assert!(!supported_bytes(kind, &[0xff, 0xd8, 0xff]));
        }
        assert!(!supported_bytes(code(b"tdta"), b"<svg onload=evil>"));
        let mut large = vec![0xff, 0xd8, 0xff];
        large.resize(MAX_RAW + 1, 0);
        assert!(!supported_bytes(code(b"JPEG"), &large));
    }
    #[test]
    fn track_changes_or_missing_binary_data_never_return_stale_artwork() {
        let mut ids = [Some("expected".to_string()), Some("expected".to_string())].into_iter();
        assert_eq!(
            bound_art("expected", &mut || ids.next().flatten(), &mut || Some(
                vec![1, 2, 3]
            )),
            Some(vec![1, 2, 3])
        );
        for pair in [
            [Some("expected".into()), Some("different".into())],
            [Some("different".into()), Some("expected".into())],
            [Some("expected".into()), None],
        ] {
            let mut ids = pair.into_iter();
            assert_eq!(
                bound_art("expected", &mut || ids.next().flatten(), &mut || Some(
                    vec![1, 2, 3]
                )),
                None
            );
        }
        assert_eq!(
            bound_art("expected", &mut || Some("expected".into()), &mut || None),
            None
        );
    }
    #[test]
    fn exact_bundle_pid_and_launch_are_required_before_reading_art() {
        let expected = Track {
            app: "com.apple.Music".into(),
            pid: 20,
            launch: "123.5".into(),
            track: "0123456789ABCDEF".into(),
            title: "Synthetic".into(),
            artist: String::new(),
            playing: true,
            browser: None,
            art: None,
            artwork_url: None,
        };
        assert!(same_identity("com.apple.Music", 20, 123.5, &expected));
        assert!(!same_identity("com.apple.Music", 21, 123.5, &expected));
        assert!(!same_identity("com.apple.Music", 20, 124.5, &expected));
        assert!(!same_identity("com.apple.Music.evil", 20, 123.5, &expected));
        assert!(!same_identity("com.apple.Music", 20, f64::NAN, &expected));
    }
}
