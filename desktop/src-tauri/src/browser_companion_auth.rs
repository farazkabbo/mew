//! Mutual local peer authentication. Browser messages never substitute for OS process identity.
//! Release peers must have valid Apple-anchored signatures from the app's signing team.
use std::{
    ffi::c_void,
    io,
    os::{
        fd::AsRawFd,
        unix::{ffi::OsStrExt, net::UnixStream},
    },
    path::PathBuf,
};
type Cf = *const c_void;
#[repr(C)]
struct Range {
    location: isize,
    length: isize,
}
#[repr(C)]
#[derive(Default)]
struct BsdInfo {
    fields: [u32; 12],
    comm: [u8; 16],
    name: [u8; 32],
    tail: [u32; 6],
    seconds: u64,
    micros: u64,
}
#[link(name = "System")]
unsafe extern "C" {
    fn getpid() -> i32;
    fn geteuid() -> u32;
    fn getpeereid(fd: i32, uid: *mut u32, gid: *mut u32) -> i32;
    fn getsockopt(fd: i32, level: i32, name: i32, value: *mut c_void, len: *mut u32) -> i32;
    fn proc_pidpath(pid: i32, buffer: *mut c_void, size: u32) -> i32;
    fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut c_void, size: i32) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Cf);
    fn CFGetTypeID(value: Cf) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFStringGetLength(value: Cf) -> isize;
    fn CFStringGetCharacters(value: Cf, range: Range, buffer: *mut u16);
    fn CFStringCreateWithBytes(
        allocator: Cf,
        bytes: *const u8,
        len: isize,
        encoding: u32,
        external: u8,
    ) -> Cf;
    fn CFNumberCreate(allocator: Cf, kind: isize, value: *const c_void) -> Cf;
    fn CFDictionaryCreateMutable(allocator: Cf, capacity: isize, keys: Cf, values: Cf) -> Cf;
    fn CFDictionarySetValue(dict: Cf, key: Cf, value: Cf);
    fn CFDictionaryGetValue(dict: Cf, key: Cf) -> Cf;
    fn CFArrayGetCount(array: Cf) -> isize;
    fn CFArrayGetValueAtIndex(array: Cf, index: isize) -> Cf;
    static kCFTypeDictionaryKeyCallBacks: u8;
    static kCFTypeDictionaryValueCallBacks: u8;
}
#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    static kSecGuestAttributePid: Cf;
    static kSecCodeInfoIdentifier: Cf;
    static kSecCodeInfoTeamIdentifier: Cf;
    static kSecCodeInfoCertificates: Cf;
    fn SecCodeCopyGuestWithAttributes(host: Cf, attributes: Cf, flags: u32, out: *mut Cf) -> i32;
    fn SecCodeCheckValidity(code: Cf, flags: u32, requirement: Cf) -> i32;
    fn SecCodeCopySigningInformation(code: Cf, flags: u32, out: *mut Cf) -> i32;
    fn SecRequirementCreateWithString(text: Cf, flags: u32, out: *mut Cf) -> i32;
    fn SecCertificateCopySubjectSummary(certificate: Cf) -> Cf;
}
struct Owned(Cf);
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}
fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Untrusted browser companion peer",
    )
}
fn text(value: Cf) -> Option<String> {
    if value.is_null() || unsafe { CFGetTypeID(value) != CFStringGetTypeID() } {
        return None;
    }
    let len = usize::try_from(unsafe { CFStringGetLength(value) }).ok()?;
    if len == 0 || len > 512 {
        return None;
    }
    let mut units = vec![0; len];
    unsafe {
        CFStringGetCharacters(
            value,
            Range {
                location: 0,
                length: len as isize,
            },
            units.as_mut_ptr(),
        )
    };
    String::from_utf16(&units)
        .ok()
        .filter(|s| !s.chars().any(char::is_control))
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Process {
    pid: i32,
    parent: i32,
    path: PathBuf,
    start: [u64; 2],
}
fn process(pid: i32) -> io::Result<Process> {
    let mut info = BsdInfo::default();
    // Public libproc PROC_PIDTBSDINFO layout, checked against the SDK's exact structure size.
    let size = std::mem::size_of::<BsdInfo>();
    if size != 136
        || pid <= 0
        || unsafe { proc_pidinfo(pid, 3, 0, (&mut info as *mut BsdInfo).cast(), size as i32) }
            != size as i32
        || info.fields[3] != pid as u32
        || info.fields[5] != unsafe { geteuid() }
    {
        return Err(denied());
    }
    let mut buffer = [0u8; 4096];
    if unsafe { proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) } <= 0 {
        return Err(denied());
    }
    let end = buffer.iter().position(|b| *b == 0).ok_or_else(denied)?;
    let path = PathBuf::from(std::ffi::OsStr::from_bytes(&buffer[..end])).canonicalize()?;
    Ok(Process {
        pid,
        parent: info.fields[4] as i32,
        path,
        start: [info.seconds, info.micros],
    })
}
struct Signature {
    identifier: String,
    team: Option<String>,
    signer: Option<String>,
}
fn signature(pid: i32, apple_anchor: bool) -> io::Result<Signature> {
    unsafe {
        let number = Owned(CFNumberCreate(
            std::ptr::null(),
            3,
            (&pid as *const i32).cast(),
        ));
        let attributes = Owned(CFDictionaryCreateMutable(
            std::ptr::null(),
            0,
            (&raw const kCFTypeDictionaryKeyCallBacks).cast(),
            (&raw const kCFTypeDictionaryValueCallBacks).cast(),
        ));
        if number.0.is_null() || attributes.0.is_null() {
            return Err(denied());
        }
        CFDictionarySetValue(attributes.0, kSecGuestAttributePid, number.0);
        let mut code = std::ptr::null();
        if SecCodeCopyGuestWithAttributes(std::ptr::null(), attributes.0, 0, &mut code) != 0 {
            return Err(denied());
        }
        let code = Owned(code);
        let rule = "anchor apple generic";
        let rule_text = Owned(CFStringCreateWithBytes(
            std::ptr::null(),
            rule.as_ptr(),
            rule.len() as isize,
            0x08000100,
            0,
        ));
        let mut requirement = std::ptr::null();
        if apple_anchor && SecRequirementCreateWithString(rule_text.0, 0, &mut requirement) != 0 {
            return Err(denied());
        }
        let requirement = Owned(requirement);
        if SecCodeCheckValidity(code.0, 1 << 4, requirement.0) != 0 {
            return Err(denied());
        }
        let mut information = std::ptr::null();
        if SecCodeCopySigningInformation(code.0, 1 << 1, &mut information) != 0 {
            return Err(denied());
        }
        let information = Owned(information);
        let identifier =
            text(CFDictionaryGetValue(information.0, kSecCodeInfoIdentifier)).ok_or_else(denied)?;
        let team = text(CFDictionaryGetValue(
            information.0,
            kSecCodeInfoTeamIdentifier,
        ));
        let certificates = CFDictionaryGetValue(information.0, kSecCodeInfoCertificates);
        let signer = if !certificates.is_null() && CFArrayGetCount(certificates) > 0 {
            let summary = Owned(SecCertificateCopySubjectSummary(CFArrayGetValueAtIndex(
                certificates,
                0,
            )));
            text(summary.0)
        } else {
            None
        };
        Ok(Signature {
            identifier,
            team,
            signer,
        })
    }
}
fn socket_peer(socket: &UnixStream) -> io::Result<i32> {
    let (mut uid, mut gid, mut pid, mut len) = (0, 0, 0i32, 4u32);
    if unsafe { getpeereid(socket.as_raw_fd(), &mut uid, &mut gid) } != 0
        || uid != unsafe { geteuid() }
        || unsafe {
            getsockopt(
                socket.as_raw_fd(),
                0,
                2,
                (&mut pid as *mut i32).cast(),
                &mut len,
            )
        } != 0
        || len != 4
        || pid <= 0
    {
        return Err(denied());
    }
    Ok(pid)
}
fn same_publisher(a: Option<&str>, b: Option<&str>, development: bool) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => !a.is_empty() && a == b,
        (None, None) => development,
        _ => false,
    }
}
fn own_peer(socket: &UnixStream, expected_name: &str, identifiers: &[&str]) -> io::Result<Process> {
    let own = process(unsafe { getpid() })?;
    let peer = process(socket_peer(socket)?)?;
    let expected = own
        .path
        .parent()
        .ok_or_else(denied)?
        .join(expected_name)
        .canonicalize()?;
    if peer.path != expected {
        return Err(denied());
    }
    let ours = signature(own.pid, !cfg!(debug_assertions))?;
    let theirs = signature(peer.pid, !cfg!(debug_assertions))?;
    if !identifiers.contains(&theirs.identifier.as_str())
        || !same_publisher(
            ours.team.as_deref(),
            theirs.team.as_deref(),
            cfg!(debug_assertions),
        )
        || process(peer.pid)? != peer
    {
        return Err(denied());
    }
    Ok(peer)
}
/// The relay only forwards requests from its actual sibling app process, never a socket impostor.
#[allow(dead_code)] // Shared source: each executable uses the opposite peer-verification entrypoint.
pub fn authenticate_server(socket: &UnixStream) -> io::Result<()> {
    own_peer(socket, "mew-desktop", &["app.mew.desktop", "mew-desktop"])?;
    Ok(())
}
#[derive(Debug, Clone)]
#[allow(dead_code)] // Constructed by the desktop side of the shared authentication source.
pub struct BrowserPeer {
    pub pid: i32,
    pub identifier: String,
    pub team: String,
    pub signer: String,
    start: [u64; 2],
    path: PathBuf,
}
pub fn browser_identifier(id: &str) -> bool {
    matches!(
        id,
        "com.google.Chrome"
            | "com.google.Chrome.beta"
            | "com.google.Chrome.canary"
            | "org.chromium.Chromium"
            | "com.brave.Browser"
            | "com.microsoft.edgemac"
            | "com.microsoft.edgemac.Beta"
            | "com.microsoft.edgemac.Dev"
            | "com.microsoft.edgemac.Canary"
            | "org.mozilla.firefox"
            | "org.mozilla.firefoxdeveloperedition"
            | "org.mozilla.nightly"
            | "com.vivaldi.Vivaldi"
            | "com.operasoftware.Opera"
            | "company.thebrowser.Browser"
    )
}
/// Browser origin strings alone are forgeable. Also require the real signed relay and its
/// live, Apple-signed browser parent; the user then explicitly pairs this publisher/profile.
#[allow(dead_code)] // Shared source: each executable uses the opposite peer-verification entrypoint.
pub fn authenticate_host(socket: &UnixStream) -> io::Result<BrowserPeer> {
    let helper = own_peer(
        socket,
        "neb-browser-host",
        &["neb-browser-host", "app.mew.desktop.browser-host"],
    )?;
    let browser = process(helper.parent)?;
    let signed = signature(browser.pid, true)?;
    if !browser_identifier(&signed.identifier) || process(browser.pid)? != browser {
        return Err(denied());
    }
    Ok(BrowserPeer {
        pid: browser.pid,
        identifier: signed.identifier,
        team: signed.team.ok_or_else(denied)?,
        signer: signed.signer.ok_or_else(denied)?,
        start: browser.start,
        path: browser.path,
    })
}
#[allow(dead_code)] // Shared source: each executable uses the opposite peer-verification entrypoint.
pub fn browser_alive(peer: &BrowserPeer) -> bool {
    process(peer.pid).is_ok_and(|p| p.start == peer.start && p.path == peer.path)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matching_publisher_is_required_and_adhoc_is_development_only() {
        assert!(same_publisher(Some("TEAM"), Some("TEAM"), false));
        assert!(!same_publisher(Some("TEAM"), Some("OTHER"), true));
        assert!(!same_publisher(None, None, false));
        assert!(same_publisher(None, None, true));
        assert!(!same_publisher(Some("TEAM"), None, true));
    }
    #[test]
    fn only_exact_browser_code_identifiers_are_eligible() {
        assert!(browser_identifier("org.mozilla.firefox"));
        for id in [
            "org.mozilla.firefox.evil",
            "com.apple.Terminal",
            "mew-desktop",
            "",
        ] {
            assert!(!browser_identifier(id));
        }
    }
}
