//! Same-process, read-only Chrome AppleEvents. Every send explicitly prohibits TCC consent
//! prompts and server interaction. Four-character properties come from Chrome's shipped
//! scripting.sdef; object specifiers and ABI layouts come from the installed public AE SDK.
use super::super::target::Rect;
use super::{FocusRequest, Mode};
use std::{
    ffi::c_void,
    time::{Duration, Instant},
};
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
    fn AECountItems(desc: *const Desc, count: *mut isize) -> i16;
    fn AEGetNthDesc(
        desc: *const Desc,
        index: isize,
        kind: u32,
        key: *mut u32,
        out: *mut Desc,
    ) -> i16;
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
fn window(all: bool) -> Option<Owned> {
    let mut root = Owned::empty();
    let mut key = if all {
        Owned::create(b"abso", &code(b"all ").to_ne_bytes())?
    } else {
        Owned::create(b"long", &1i32.to_ne_bytes())?
    };
    spec(b"cwin", &mut root, b"indx", &mut key)
}
fn property(all: bool, name: &[u8; 4]) -> Option<Owned> {
    let mut w = window(all)?;
    let mut key = Owned::create(b"type", &code(name).to_ne_bytes())?;
    spec(b"prop", &mut w, b"prop", &mut key)
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
    fn get(&self, all: bool, name: &[u8; 4], kind: &[u8; 4]) -> Option<Owned> {
        if !self.live() {
            return None;
        }
        let object = property(all, name)?;
        self.get_object(object, kind)
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
    fn text(&self, name: &[u8; 4]) -> Option<String> {
        String::from_utf8(self.get(false, name, b"utf8")?.bytes(64)?).ok()
    }
    fn bounds(&self) -> Option<Rect> {
        rectangle(&self.get(false, b"pbnd", b"qdrt")?.bytes(8)?)
    }
    fn all_bounds(&self) -> Option<Vec<Rect>> {
        let list = self.get(true, b"pbnd", b"list")?;
        let mut count = 0;
        if unsafe { AECountItems(&list.0, &mut count) } != 0 || !(1..=512).contains(&count) {
            return None;
        }
        let mut bounds = Vec::with_capacity(count as usize);
        for index in 1..=count {
            if !self.live() {
                return None;
            }
            let mut item = Owned::empty();
            if unsafe {
                AEGetNthDesc(
                    &list.0,
                    index,
                    code(b"qdrt"),
                    std::ptr::null_mut(),
                    &mut item.0,
                )
            } != 0
            {
                return None;
            }
            bounds.push(rectangle(&item.bytes(8)?)?);
        }
        Some(bounds)
    }
}
fn rectangle(bytes: &[u8]) -> Option<Rect> {
    let bytes = <&[u8; 8]>::try_from(bytes).ok()?;
    let n = |at| f64::from(i16::from_ne_bytes([bytes[at], bytes[at + 1]]));
    let (top, left, bottom, right) = (n(0), n(2), n(4), n(6));
    Rect::new(left, top, right - left, bottom - top)
}
#[allow(clippy::too_many_arguments)] // Before/after evidence deliberately stays explicit.
fn bound_mode(
    expected: Rect,
    before: Rect,
    after: Rect,
    all: &[Rect],
    id: &str,
    after_id: &str,
    mode: &str,
    after_mode: &str,
) -> Mode {
    if before != expected
        || after != expected
        || all.iter().filter(|b| **b == expected).count() != 1
        || id.is_empty()
        || id.len() > 20
        || !id.bytes().all(|b| b.is_ascii_digit())
        || id != after_id
        || mode != after_mode
    {
        return Mode::Unknown;
    }
    match mode {
        "normal" => Mode::Normal,
        "incognito" => Mode::Private,
        _ => Mode::Unknown,
    }
}
pub(super) fn sample(request: &FocusRequest, bounds: Rect, current: &dyn Fn() -> bool) -> Mode {
    fn checked(request: &FocusRequest, bounds: Rect, current: &dyn Fn() -> bool) -> Option<Mode> {
        if !super::super::app_policy::has_inspected_browser_dictionary(&request.bundle)
            || request.pid <= 0
            || request.cg_window_id == 0
            || request.generation == 0
            || !current()
        {
            return None;
        }
        let q = Query {
            address: Owned::create(b"kpid", &request.pid.to_ne_bytes())?,
            current,
            deadline: Instant::now() + Duration::from_secs(2),
        };
        let id = q.text(b"ID  ")?;
        let before = q.bounds()?;
        let mode = q.text(b"mode")?;
        let all = q.all_bounds()?;
        let after_id = q.text(b"ID  ")?;
        let after = q.bounds()?;
        let after_mode = q.text(b"mode")?;
        if !q.live() {
            return None;
        }
        Some(bound_mode(
            bounds,
            before,
            after,
            &all,
            &id,
            &after_id,
            &mode,
            &after_mode,
        ))
    }
    checked(request, bounds, current).unwrap_or(Mode::Unknown)
}
/// Read only for an explicit Save, using the same exact-window normal-mode transaction.
pub(super) fn source(
    request: &FocusRequest,
    bounds: Rect,
    current: &dyn Fn() -> bool,
) -> Option<(String, String)> {
    if sample(request, bounds, current) != Mode::Normal {
        return None;
    }
    let q = Query {
        address: Owned::create(b"kpid", &request.pid.to_ne_bytes())?,
        current,
        deadline: Instant::now() + Duration::from_millis(350),
    };
    let read = |name: &[u8; 4], max| {
        let mut tab = property(false, b"acTa")?;
        let mut key = Owned::create(b"type", &code(name).to_ne_bytes())?;
        let object = spec(b"prop", &mut tab, b"prop", &mut key)?;
        String::from_utf8(q.get_object(object, b"utf8")?.bytes(max)?).ok()
    };
    let url = read(b"URL ", 2000)?;
    let title = read(b"pnam", 800).unwrap_or_default();
    (current() && sample(request, bounds, current) == Mode::Normal).then_some((title, url))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_sdk_abi_and_send_flags_are_explicitly_no_prompt() {
        assert_eq!(std::mem::size_of::<Desc>(), 12);
        assert_eq!(std::mem::align_of::<Desc>(), 2);
        assert_eq!(SEND_MODE & 0x20000, 0x20000);
        assert_eq!(SEND_MODE & 0x30, 0x10);
    }
    #[test]
    fn bounds_identity_and_unique_geometry_all_bind_mode() {
        let r = Rect::new(-1440., -200., 1200., 800.).unwrap();
        assert_eq!(
            bound_mode(r, r, r, &[r], "42", "42", "normal", "normal"),
            Mode::Normal
        );
        assert_eq!(
            bound_mode(r, r, r, &[r], "42", "42", "incognito", "incognito"),
            Mode::Private
        );
        assert_eq!(
            bound_mode(r, r, r, &[r, r], "42", "42", "normal", "normal"),
            Mode::Unknown
        );
        assert_eq!(
            bound_mode(r, r, r, &[r], "42", "43", "normal", "normal"),
            Mode::Unknown
        );
        assert_eq!(
            bound_mode(r, r, r, &[r], "42", "42", "normal", "incognito"),
            Mode::Unknown
        );
    }
    #[test]
    fn public_qdrect_layout_keeps_negative_origins_and_rejects_malformed() {
        let bytes = [-200i16, -1440, 600, -240]
            .into_iter()
            .flat_map(i16::to_ne_bytes)
            .collect::<Vec<_>>();
        assert_eq!(rectangle(&bytes), Rect::new(-1440., -200., 1200., 800.));
        assert!(rectangle(&bytes[..7]).is_none());
        assert!(rectangle(&[0; 8]).is_none());
    }
}
