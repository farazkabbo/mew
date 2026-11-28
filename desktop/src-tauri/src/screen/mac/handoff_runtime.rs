//! Mac Handoff: origin/account-scoped encrypted local timeline, exact local preview, explicit
//! Send of the reviewed encrypted package, and separately confirmed allowlisted pickup steps.
use super::{
    capture, capture_session, chores, handoff_crypto as crypto, privacy, runtime, service_call,
    target,
};
use crate::screen::{
    base64,
    handoff::{
        package::{self, Brief, Draft, DraftMoment},
        pickup::{self, Action, GitStep},
        redact::{self, Found, Kind},
        select,
        settings::HandoffSettings,
        timeline::{self, Event, Moment, Snapshot},
    },
    image::Pixels,
    protocol::{self, ClipHead},
    secret::{wipe, SecretBytes},
    sign_in::SignIn,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    http::{Request, Response},
    ipc::CapabilityBuilder,
    AppHandle, Manager, UriSchemeContext, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
pub const WINDOW: &str = "handoff";
pub const SCHEME: &str = "mewhandoff";
#[path = "handoff_metadata.rs"]
mod metadata;
const MAX_RECORD: usize = 3 * 1024 * 1024;
const MAX_FILE: u64 = 64 * 1024 * 1024;
const DRAFT_TTL: Duration = Duration::from_secs(15 * 60);
#[derive(Default)]
struct Host {
    live: Mutex<Option<Live>>,
    file: Mutex<()>,
    revision: AtomicU64,
    last_snapshot: Mutex<Option<i64>>,
}
struct Live {
    nonce: String,
    revision: u64,
    generation: u64,
    stamp: [u8; 32],
    created: Instant,
    phase: &'static str,
    message: Option<String>,
    draft: Option<Draft>,
    hint: Option<String>,
    link: Option<String>,
}
fn state(app: &AppHandle) -> Result<tauri::State<'_, Host>, String> {
    app.try_state()
        .ok_or_else(|| "Handoff is not ready.".into())
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs()) as i64
}
pub fn settings(app: &AppHandle) -> HandoffSettings {
    runtime::of(app)
        .map(|r| r.snapshot().0.handoff)
        .unwrap_or_default()
}
fn enabled(app: &AppHandle) -> bool {
    runtime::of(app).is_ok_and(|r| {
        let (c, reset) = r.snapshot();
        !reset && c.is_on() && !c.paused && c.handoff.timeline
    })
}
fn live(app: &AppHandle, l: &Live) -> bool {
    enabled(app)
        && l.created.elapsed() < DRAFT_TTL
        && runtime::of(app).is_ok_and(|r| r.generation.load(Ordering::Acquire) == l.generation)
        && state(app).is_ok_and(|h| h.revision.load(Ordering::Acquire) == l.revision)
}
fn current(app: &AppHandle, revision: u64, generation: u64) -> bool {
    runtime::of(app).is_ok_and(|r| {
        let (c, reset) = r.snapshot();
        !reset && c.is_on() && !c.paused
    }) && state(app).is_ok_and(|h| h.revision.load(Ordering::Acquire) == revision)
        && runtime::of(app).is_ok_and(|r| r.generation.load(Ordering::Acquire) == generation)
}
fn account_scope(app: &AppHandle, stamp: &[u8; 32]) -> Result<String, String> {
    if service_call::credential_stamp(app).map_err(|e| e.to_string())? != *stamp {
        return Err("The account changed.".into());
    }
    let sign = app
        .try_state::<SignIn>()
        .ok_or("Account services aren't ready.")?;
    let hex = stamp.iter().map(|b| format!("{b:02x}")).collect::<String>();
    Ok(format!(
        "{}:{hex}",
        sign.app_url().origin().ascii_serialization()
    ))
}
fn timeline_path(app: &AppHandle, stamp: &[u8; 32]) -> Result<PathBuf, String> {
    let name = stamp.iter().map(|b| format!("{b:02x}")).collect::<String>();
    app.path()
        .app_local_data_dir()
        .map(|d| d.join(format!("handoff-{name}.bin")))
        .map_err(|_| "Couldn't locate Handoff storage.".into())
}
pub fn setup(app: &AppHandle) -> Result<(), String> {
    app.manage(Host::default());
    app.add_capability(
        CapabilityBuilder::new("mac-handoff")
            .local(true)
            .window(WINDOW)
            .permission("allow-handoff-preview-state")
            .permission("allow-handoff-preview-update")
            .permission("allow-handoff-preview-blur")
            .permission("allow-handoff-preview-send")
            .permission("allow-handoff-preview-copy")
            .permission("allow-handoff-preview-cancel"),
    )
    .map_err(|_| "Couldn't configure Handoff preview.")?;
    let handle = app.clone();
    std::thread::Builder::new()
        .name("neb-handoff-timeline".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            if let Ok(h) = state(&handle) {
                let mut slot = h.live.lock().unwrap_or_else(|p| p.into_inner());
                if slot.as_ref().is_some_and(|l| !live(&handle, l)) {
                    slot.take();
                }
            }
            if enabled(&handle) {
                let due = state(&handle).is_ok_and(|h| {
                    timeline::snapshot_due(
                        *h.last_snapshot.lock().unwrap_or_else(|p| p.into_inner()),
                        now(),
                    )
                });
                if due {
                    record_frontmost(&handle);
                }
            }
        })
        .map_err(|_| "Couldn't start Handoff timeline.")?;
    Ok(())
}
pub fn cancel_all(app: &AppHandle) {
    if let Ok(h) = state(app) {
        h.revision.fetch_add(1, Ordering::AcqRel);
        h.live.lock().unwrap_or_else(|p| p.into_inner()).take();
    }
    if let Some(w) = app.get_webview_window(WINDOW) {
        let _ = w.hide();
    }
}
pub fn forget_timeline(app: &AppHandle) {
    cancel_all(app);
    let Ok(dir) = app.path().app_local_data_dir() else {
        return;
    };
    let Ok(h) = state(app) else {
        return;
    };
    let _guard = h.file.lock().unwrap_or_else(|p| p.into_inner());
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("handoff-") && name.ends_with(".bin") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}
fn read_records(path: &Path, scope: &str) -> Result<Vec<Event>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("Couldn't read Handoff timeline.".into()),
    };
    if file
        .metadata()
        .map_err(|_| "Couldn't read timeline size.")?
        .len()
        > MAX_FILE
    {
        return Err("Handoff timeline exceeds its storage limit.".into());
    }
    let mut reader = file.take(MAX_FILE);
    let mut result = vec![];
    loop {
        let mut size = [0; 4];
        let count = reader
            .read(&mut size)
            .map_err(|_| "Couldn't read timeline record.")?;
        if count == 0 {
            break;
        }
        reader
            .read_exact(&mut size[count..])
            .map_err(|_| "Timeline record is incomplete.")?;
        let size = u32::from_be_bytes(size) as usize;
        if size == 0 || size > MAX_RECORD + 33 {
            return Err("Timeline record exceeds its limit.".into());
        }
        let mut sealed = SecretBytes::zeroed(size);
        reader
            .read_exact(sealed.as_mut_slice())
            .map_err(|_| "Timeline record is incomplete.")?;
        let plain = crypto::unprotect(scope, sealed.as_slice())
            .ok_or("Handoff timeline is locked or a record failed authentication.")?;
        result.push(
            serde_json::from_slice::<Event>(plain.as_slice())
                .map_err(|_| "Timeline record is invalid.")?,
        );
        if result.len() > 5000 {
            return Err("Handoff timeline has too many records.".into());
        }
    }
    Ok(timeline::keep_recent(result, now()))
}

fn write_records(path: &Path, scope: &str, events: &[Event]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid timeline path.")?;
    fs::create_dir_all(parent).map_err(|_| "Couldn't create Handoff storage.")?;
    let temp = path.with_extension("tmp");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|_| "Couldn't update Handoff timeline.")?;
    let mut total = 0u64;
    for event in events.iter().rev() {
        let plain = SecretBytes::from_vec(
            serde_json::to_vec(event).map_err(|_| "Invalid timeline event.")?,
        );
        if plain.len() > MAX_RECORD {
            continue;
        }
        let sealed =
            crypto::protect(scope, plain.as_slice()).ok_or("Couldn't encrypt Handoff timeline.")?;
        if total + sealed.len() as u64 + 4 > MAX_FILE {
            break;
        }
        file.write_all(&(sealed.len() as u32).to_be_bytes())
            .and_then(|_| file.write_all(sealed.as_slice()))
            .map_err(|_| "Couldn't write Handoff timeline.")?;
        total += sealed.len() as u64 + 4;
    }
    file.sync_all()
        .map_err(|_| "Couldn't save Handoff timeline.")?;
    fs::rename(temp, path).map_err(|_| "Couldn't replace Handoff timeline.".into())
}
fn append(app: &AppHandle, stamp: [u8; 32], event: Event) {
    if !enabled(app) {
        return;
    }
    let Ok(scope) = account_scope(app, &stamp) else {
        return;
    };
    let Ok(path) = timeline_path(app, &stamp) else {
        return;
    };
    let Ok(h) = state(app) else {
        return;
    };
    let _guard = h.file.lock().unwrap_or_else(|p| p.into_inner());
    let Ok(mut events) = read_records(&path, &scope) else {
        return;
    };
    events.push(event);
    let events = timeline::keep_recent(events, now());
    let _ = write_records(&path, &scope, &events);
}
fn load(app: &AppHandle, stamp: &[u8; 32]) -> Result<Vec<Event>, String> {
    let scope = account_scope(app, stamp)?;
    let path = timeline_path(app, stamp)?;
    let h = state(app)?;
    let _guard = h.file.lock().unwrap_or_else(|p| p.into_inner());
    let events = read_records(&path, &scope)?;
    write_records(&path, &scope, &events)?;
    Ok(events)
}
/// Called only after a native clip save succeeded. Handoff's stricter OCR covers are applied
/// again to the exact crop before its bytes enter the encrypted local timeline.
pub fn record_clip(
    app: &AppHandle,
    small: &Pixels,
    head: &ClipHead,
    on_screen: crate::screen::frame::ScreenRect,
    text: &crate::screen::screen_text::ScreenText,
    stamp: [u8; 32],
) {
    if !enabled(app) {
        return;
    }
    let mut pixels = Pixels {
        width: small.width,
        height: small.height,
        channels: small.channels,
        data: SecretBytes::from_vec(small.data.as_slice().to_vec()),
    };
    let sx = f64::from(small.width) / f64::from(on_screen.width().max(1));
    let sy = f64::from(small.height) / f64::from(on_screen.height().max(1));
    let covers = text
        .handoff_covers(on_screen)
        .into_iter()
        .map(|r| crate::screen::privacy::redact::PixelRect {
            left: ((r.left - on_screen.left) as f64 * sx).floor().max(0.) as u32,
            top: ((r.top - on_screen.top) as f64 * sy).floor().max(0.) as u32,
            right: (((r.right - on_screen.left) as f64 * sx).ceil() as u32 + 2).min(small.width),
            bottom: (((r.bottom - on_screen.top) as f64 * sy).ceil() as u32 + 2).min(small.height),
        })
        .collect::<Vec<_>>();
    crate::screen::privacy::redact::fill(&mut pixels, &covers, [24, 24, 24]);
    let Ok(jpeg) = capture::encode_jpeg(&pixels, 0.85) else {
        return;
    };
    let turn = head.entry.as_ref().map(|e| &e.turn);
    let moment = Moment {
        at: now(),
        app: head.source.app.clone(),
        window: head.source.title.clone().unwrap_or_default(),
        jpeg: base64::encode(jpeg.as_slice()),
        width: small.width,
        height: small.height,
        question: turn.map(|t| t.question.clone()),
        explanation: turn.map(|t| t.steps.join(" ")),
        ink: head
            .strokes
            .iter()
            .map(|s| timeline::Ink {
                color: s.color.clone(),
                width: s.width,
                points: s.points.clone(),
            })
            .collect(),
        ocr: head.ocr_text.chars().take(2000).collect(),
        url: head.source.url.clone(),
    };
    let mut found = Found::new();
    let moment = package::redact_moment(&moment, &mut found);
    append(app, stamp, Event::Moment(moment));
}
/// A separate, local metadata consent contract for known editors/terminals. This grants no
/// capture or field-value reads; all geometry and focus identities must be positively bound.
fn metadata_current_main(
    app: &AppHandle,
    expected: &super::pipeline::Target,
    generation: u64,
) -> bool {
    use super::hand_policy_ax as ax;
    if !enabled(app)
        || !runtime::of(app).is_ok_and(|r| r.generation.load(Ordering::Acquire) == generation)
        || metadata::producer(&expected.process.bundle_id).is_none()
        || !privacy::accessibility_trusted()
        || privacy::frontmost_process_identity().as_ref() != Some(&expected.process)
    {
        return false;
    }
    let config = runtime::of(app).unwrap().snapshot().0;
    if super::app_policy::blocked_app(&expected.process.bundle_id, &config.privacy.blocked_apps)
        .is_some()
        || metadata::producer(&expected.process.bundle_id).is_some_and(|wire| {
            config
                .privacy
                .blocked_apps
                .iter()
                .any(|entry| entry.eq_ignore_ascii_case(wire))
        })
    {
        return false;
    }
    let deadline = Instant::now() + Duration::from_millis(100);
    let check = (|| {
        let application = ax::application(expected.process.pid)?;
        if !ax::element(application.0, expected.process.pid) {
            return None;
        }
        let window = ax::attr(application.0, "AXFocusedWindow", deadline)?;
        let focused = ax::attr(application.0, "AXFocusedUIElement", deadline)?;
        if !ax::element(window.0, expected.process.pid)
            || !ax::element(focused.0, expected.process.pid)
        {
            return None;
        }
        if !ax::equal(&window, &ax::attr(focused.0, "AXWindow", deadline)?) {
            return None;
        }
        let pos = ax::pair(ax::attr(window.0, "AXPosition", deadline)?.0, 1)?;
        let size = ax::pair(ax::attr(window.0, "AXSize", deadline)?.0, 2)?;
        if target::Rect::new(pos.a, pos.b, size.a, size.b) != Some(expected.quartz_points) {
            return None;
        }
        let role = ax::string(ax::attr(focused.0, "AXRole", deadline)?.0)?;
        let subrole = metadata_subrole(focused.0, deadline)?;
        if !matches!(
            role.as_str(),
            "AXTextArea"
                | "AXTextField"
                | "AXWebArea"
                | "AXButton"
                | "AXScrollArea"
                | "AXOutline"
                | "AXTable"
        ) || subrole.as_deref() == Some("AXSecureTextField")
            || (role == "AXTextField" && subrole.as_deref() != Some("AXSearchField"))
        {
            return None;
        }
        let windows = target::visible_windows()?;
        if windows
            .iter()
            .filter(|w| {
                w.pid == expected.process.pid && w.bounds == expected.quartz_points && w.layer == 0
            })
            .count()
            != 1
            || !windows.iter().any(|w| {
                w.id == expected.window_id
                    && w.pid == expected.process.pid
                    && w.bounds == expected.quartz_points
            })
        {
            return None;
        }
        if config.privacy.pause_during_calls
            && super::call_signals::sample(deadline, &|| Instant::now() < deadline).state
                != super::call_signals::SignalState::KnownSignalsIdle
        {
            return None;
        }
        Some(
            Instant::now() < deadline
                && privacy::frontmost_process_identity().as_ref() == Some(&expected.process),
        )
    })();
    check == Some(true)
}
fn metadata_subrole(element: *const std::ffi::c_void, deadline: Instant) -> Option<Option<String>> {
    use super::hand_policy_ax as ax;
    use std::ffi::c_void;
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXUIElementCopyAttributeValue(
            element: *const c_void,
            name: *const c_void,
            out: *mut *const c_void,
        ) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithBytes(
            allocator: *const c_void,
            bytes: *const u8,
            length: isize,
            encoding: u32,
            external: u8,
        ) -> *const c_void;
    }
    let key = ax::Owned::new(unsafe {
        CFStringCreateWithBytes(std::ptr::null(), b"AXSubrole".as_ptr(), 9, 0x08000100, 0)
    })?;
    let mut out = std::ptr::null();
    let status = unsafe { AXUIElementCopyAttributeValue(element, key.0, &mut out) };
    let owned = ax::Owned::new(out);
    if Instant::now() >= deadline {
        return None;
    }
    match status {
        -25205 => Some(None),
        0 => Some(Some(ax::string(owned?.0)?)),
        _ => None,
    }
}
fn metadata_current(app: &AppHandle, target: &super::pipeline::Target, generation: u64) -> bool {
    if metadata::producer(&target.process.bundle_id).is_none() {
        return capture_session::is_target_current(app, target, generation);
    }
    let target = target.clone();
    let handle = app.clone();
    let (tx, rx) = mpsc::sync_channel(1);
    let deadline = Instant::now() + Duration::from_millis(250);
    let _ = app.run_on_main_thread(move || {
        if Instant::now() < deadline {
            let _ = tx.send(metadata_current_main(&handle, &target, generation));
        }
    });
    rx.recv_timeout(Duration::from_millis(300)).unwrap_or(false)
}
fn record_frontmost(app: &AppHandle) {
    let Ok(stamp) = service_call::credential_stamp(app) else {
        return;
    };
    let Ok(r) = runtime::of(app) else {
        return;
    };
    let generation = r.generation.load(Ordering::Acquire);
    let valid = || {
        enabled(app)
            && service_call::credential_stamp(app).ok() == Some(stamp)
            && runtime::of(app).is_ok_and(|r| r.generation.load(Ordering::Acquire) == generation)
    };
    let (tx, rx) = mpsc::sync_channel(1);
    let deadline = Instant::now() + Duration::from_millis(300);
    let _ = app.run_on_main_thread(move || {
        if Instant::now() >= deadline {
            return;
        }
        let found = (|| {
            let process = privacy::frontmost_process_identity()?;
            let window = target::frontmost_window_candidate(&target::AppIdentity {
                pid: process.pid,
                bundle_id: Some(process.bundle_id.clone()),
            })?;
            Some(super::pipeline::Target {
                window_id: window.id,
                process,
                quartz_points: window.bounds,
            })
        })();
        let _ = tx.send(found);
    });
    let Ok(Some(target)) = rx.recv_timeout(Duration::from_millis(350)) else {
        return;
    };
    if !valid() || !metadata_current(app, &target, generation) {
        return;
    }
    let mut snapshot = Snapshot {
        at: now(),
        app: metadata::producer(&target.process.bundle_id)
            .or_else(|| super::app_policy::wire_name(&target.process.bundle_id))
            .unwrap_or(&target.process.bundle_id)
            .into(),
        ..Snapshot::default()
    };
    let expected = target.clone();
    let handle = app.clone();
    let (tx, rx) = mpsc::sync_channel(1);
    let deadline = Instant::now() + Duration::from_millis(900);
    let _ = app.run_on_main_thread(move || {
        use super::hand_policy_ax as ax;
        let bound = || {
            Instant::now() < deadline
                && if metadata::producer(&expected.process.bundle_id).is_some() {
                    metadata_current_main(&handle, &expected, generation)
                } else {
                    capture_session::target_is_current_main(&handle, &expected, generation)
                }
        };
        let read = (|| {
            if !bound() {
                return None;
            }
            if super::app_policy::has_inspected_browser_dictionary(&expected.process.bundle_id) {
                let req = super::browser_mode::FocusRequest {
                    bundle: expected.process.bundle_id.clone(),
                    pid: expected.process.pid,
                    launch: f64::from_bits(expected.process.launch_time_bits).to_string(),
                    cg_window_id: expected.window_id,
                    generation,
                };
                let (title, url) =
                    super::browser_mode::saved_source(&req, expected.quartz_points, &bound)?;
                return Some((Some(title), None, Some(url)));
            }
            let application = ax::application(expected.process.pid)?;
            let window = ax::attr(application.0, "AXFocusedWindow", deadline)?;
            let p = ax::pair(ax::attr(window.0, "AXPosition", deadline)?.0, 1)?;
            let size = ax::pair(ax::attr(window.0, "AXSize", deadline)?.0, 2)?;
            if target::Rect::new(p.a, p.b, size.a, size.b) != Some(expected.quartz_points) {
                return None;
            }
            let title =
                ax::attr(window.0, "AXTitle", deadline).and_then(|v| ax::string_bounded(v.0, 200));
            let document = ax::attr(window.0, "AXDocument", deadline)
                .and_then(|v| ax::string_bounded(v.0, 2000));
            bound().then_some((title, document, None))
        })();
        let _ = tx.send(read);
    });
    let Ok(Some((title, document, url))) = rx.recv_timeout(Duration::from_millis(950)) else {
        return;
    };
    if !valid() || !metadata_current(app, &target, generation) {
        return;
    }
    snapshot.window = title.unwrap_or_default();
    snapshot.url = url
        .and_then(|s| crate::screen::source::sanitize_url(&s))
        .map(|u| u.to_string());
    snapshot.path = document
        .as_deref()
        .and_then(|s| Url::parse(s).ok())
        .filter(|u| u.scheme() == "file")
        .and_then(|u| u.to_file_path().ok())
        .map(|p| p.to_string_lossy().into_owned());
    if snapshot.path.is_none() && metadata::producer(&target.process.bundle_id).is_some() {
        snapshot.path = metadata::title_path(&snapshot.window).map(|p| {
            if let Some(tail) = p.strip_prefix("~/") {
                home()
                    .map(|h| h.join(tail).to_string_lossy().into_owned())
                    .unwrap_or(p)
            } else {
                p
            }
        });
    }
    snapshot.document = snapshot
        .path
        .as_deref()
        .and_then(|p| Path::new(p).file_name())
        .map(|p| p.to_string_lossy().into_owned());
    if metadata::producer(&target.process.bundle_id).is_some() {
        snapshot.git = snapshot
            .path
            .as_deref()
            .and_then(|p| Path::new(p).canonicalize().ok())
            .filter(|p| home().is_ok_and(|h| p.starts_with(h)))
            .and_then(|p| crate::screen::handoff::context::repo_of(&p, |d| d.join(".git").exists()))
            .and_then(|repo| repo.canonicalize().ok())
            .filter(|repo| home().is_ok_and(|h| repo.starts_with(h)))
            .and_then(|repo| {
                use crate::screen::handoff::context::{parse_git, READ_ONLY};
                let run = |args: &[&str]| git_read_only(&repo, args, &valid);
                Some(parse_git(
                    &repo,
                    &run(READ_ONLY[0])?,
                    &run(READ_ONLY[1]).unwrap_or_default(),
                    &run(READ_ONLY[2]).unwrap_or_default(),
                    &run(READ_ONLY[3]).unwrap_or_default(),
                ))
            });
    }
    if !valid() || !metadata_current(app, &target, generation) {
        return;
    }
    let mut found = Found::new();
    append(
        app,
        stamp,
        Event::Snapshot(package::redact_snapshot(&snapshot, &mut found)),
    );
    if let Ok(h) = state(app) {
        *h.last_snapshot.lock().unwrap_or_else(|p| p.into_inner()) = Some(now());
    }
}
fn git_read_only(repo: &Path, args: &[&str], valid: &dyn Fn() -> bool) -> Option<String> {
    if !valid() || !crate::screen::handoff::context::READ_ONLY.contains(&args) {
        return None;
    }
    let mut command = Command::new("/usr/bin/git");
    command
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "log.showSignature=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "diff.external=",
        ])
        .arg("-C")
        .arg(repo)
        .args(args);
    if args.first() == Some(&"diff") {
        command.arg("--no-ext-diff").arg("--no-textconv");
    }
    let mut child = command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_PAGER", "cat")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.take(64 * 1024 + 1).read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let start = Instant::now();
    let mut output = None;
    let result = loop {
        if !valid() || start.elapsed() >= Duration::from_secs(2) {
            break None;
        }
        if output.is_none() {
            if let Ok(bytes) = rx.try_recv() {
                if bytes.len() > 64 * 1024 {
                    break None;
                }
                output = Some(bytes);
            }
        }
        match child.try_wait() {
            Ok(Some(s)) if !s.success() => break None,
            Ok(Some(_)) if output.is_some() => {
                break String::from_utf8(output.take().unwrap()).ok()
            }
            Err(_) => break None,
            _ => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    if result.is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    result
}

pub fn debug_view(app: &AppHandle) -> Value {
    let Ok(stamp) = service_call::credential_stamp(app) else {
        return json!({"count":0,"recent":[]});
    };
    let events = load(app, &stamp).unwrap_or_default();
    json!({"count":events.len(),"recent":events.iter().rev().take(50).map(|e|json!({"at":package::iso(e.at()),"kind":match e{Event::Moment(_)=>"moment",Event::Snapshot(_)=>"snapshot"}})).collect::<Vec<_>>()})
}
fn open_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window(WINDOW) {
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        let dev = handle.config().build.dev_url.clone();
        let _ = WebviewWindowBuilder::new(&handle, WINDOW, WebviewUrl::App("handoff.html".into()))
            .title("Neb · Hand off")
            .inner_size(1040., 760.)
            .min_inner_size(720., 520.)
            .on_navigation(move |u| {
                crate::screen::is_local_page(u, dev.as_ref()) && u.path() == "/handoff.html"
            })
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .build();
    });
}
pub fn start(app: &AppHandle, hint: Option<String>) -> Result<(), String> {
    if !enabled(app) {
        return Err(
            "Enable Handoff's 24-hour timeline in local Screen Coach settings first.".into(),
        );
    }
    let stamp = service_call::credential_stamp(app).map_err(|e| e.to_string())?;
    let generation = runtime::of(app)?.generation.load(Ordering::Acquire);
    // Capture current metadata before the preview can become the foreground window.
    // This is metadata-only and deliberately bypasses the periodic debounce, as Windows does.
    record_frontmost(app);
    let h = state(app)?;
    let revision = h.revision.fetch_add(1, Ordering::AcqRel) + 1;
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(|_| "Couldn't create a Handoff preview.")?;
    let nonce = base64::encode_url_safe(&random);
    *h.live.lock().unwrap_or_else(|p| p.into_inner()) = Some(Live {
        nonce,
        revision,
        generation,
        stamp,
        created: Instant::now(),
        phase: "building",
        message: None,
        draft: None,
        hint: hint.clone(),
        link: None,
    });
    open_window(app);
    let app = app.clone();
    std::thread::Builder::new()
        .name("neb-handoff-build".into())
        .spawn(move || {
            let built = build(&app, stamp, revision, generation, hint.as_deref());
            if let Ok(h) = state(&app) {
                if let Some(l) = h
                    .live
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .as_mut()
                    .filter(|l| l.revision == revision && live(&app, l))
                {
                    match built {
                        Ok(Some(d)) => {
                            l.phase = "ready";
                            l.draft = Some(d);
                        }
                        Ok(None) => l.phase = "empty",
                        Err(e) => {
                            l.phase = "failed";
                            l.message = Some(e);
                        }
                    }
                }
            }
        })
        .map_err(|_| "Couldn't build Handoff.".to_owned())?;
    Ok(())
}
fn build(
    app: &AppHandle,
    stamp: [u8; 32],
    revision: u64,
    generation: u64,
    hint: Option<&str>,
) -> Result<Option<Draft>, String> {
    let prefs = settings(app);
    let events = load(app, &stamp)?;
    let (moments, snapshots) = select::session(&events, now(), prefs.window_min);
    if moments.is_empty() && snapshots.is_empty() {
        return Ok(None);
    }
    let mut found = Found::new();
    let key = select::key_moments(&moments, now());
    let draft_moments = key
        .iter()
        .enumerate()
        .map(|(i, &n)| {
            let m = package::redact_moment(&moments[n], &mut found);
            DraftMoment {
                id: format!("m{}", i + 1),
                include: true,
                crop: base64::decode(&m.jpeg).unwrap_or_default(),
                moment: Moment {
                    jpeg: String::new(),
                    ..m
                },
            }
        })
        .collect::<Vec<_>>();
    let snapshots = snapshots
        .iter()
        .map(|s| package::redact_snapshot(s, &mut found))
        .collect::<Vec<_>>();
    let first = moments
        .first()
        .map_or(now(), |m| m.at)
        .min(snapshots.first().map_or(now(), |s| s.at));
    let sender = if prefs.sender_name.is_empty() {
        "A teammate".into()
    } else {
        prefs.sender_name
    };
    let all = draft_moments
        .iter()
        .flat_map(|m| [m.moment.question.clone(), m.moment.explanation.clone()])
        .flatten()
        .collect::<Vec<_>>()
        .join("\n");
    let names = redact::possible_names(
        &all,
        &[sender.split(' ').next().unwrap_or(""), hint.unwrap_or("")],
    );
    let mut draft = Draft {
        sender_name: sender,
        language: "en".into(),
        created_at: package::iso(now()),
        from: package::iso(first),
        to: package::iso(now()),
        moments: draft_moments,
        snapshots,
        brief: Brief::default(),
        found,
        names,
    };
    let crops = draft
        .moments
        .iter()
        .rev()
        .take(4)
        .filter_map(|m| {
            Some((
                m.id.clone(),
                base64::encode(crypto::image(&m.crop, None, 768)?.as_slice()),
            ))
        })
        .collect::<Vec<_>>();
    let body = SecretBytes::from_vec(
        serde_json::to_vec(&package::brief_request(&draft, &crops))
            .map_err(|_| "Couldn't prepare brief.")?,
    );
    let reply =
        service_call::post_bound(app, "api/handoff/brief", body.as_slice(), &stamp, &|| {
            !current(app, revision, generation)
        });
    let ids = draft
        .moments
        .iter()
        .map(|m| m.id.clone())
        .collect::<Vec<_>>();
    let checked = reply
        .ok()
        .and_then(|r| serde_json::from_slice::<Value>(r.as_slice()).ok())
        .and_then(|r| Brief::checked(&r["brief"], &ids));
    if !current(app, revision, generation) {
        return Err("Handoff was cancelled.".into());
    }
    if let Some((brief, found)) = checked {
        draft.brief = brief;
        redact::merge(&mut draft.found, &found);
    } else {
        draft.brief = Brief {
            title: draft
                .moments
                .last()
                .map(|m| m.moment.window.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Handoff".into()),
            tried: draft
                .moments
                .iter()
                .filter_map(|m| {
                    Some(package::Cited {
                        text: m.moment.question.clone()?,
                        moment_id: Some(m.id.clone()),
                    })
                })
                .collect(),
            ..Brief::default()
        };
    }
    if prefs.always_hide_names {
        package::hide_names(&mut draft);
    }
    Ok(Some(draft))
}
fn require_preview(window: &WebviewWindow) -> Result<(), String> {
    let dev = window.app_handle().config().build.dev_url.as_ref();
    if window.label() == WINDOW
        && window
            .url()
            .is_ok_and(|u| crate::screen::is_local_page(&u, dev) && u.path() == "/handoff.html")
    {
        Ok(())
    } else {
        Err("Not allowed.".into())
    }
}
pub fn serve(
    ctx: UriSchemeContext<'_, tauri::Wry>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let miss = || {
        Response::builder()
            .status(404)
            .header("Cache-Control", "no-store")
            .body(Vec::new())
            .unwrap_or_default()
    };
    if ctx.webview_label() != WINDOW || request.method() != "GET" {
        return miss();
    }
    let Some(w) = ctx.app_handle().get_webview_window(WINDOW) else {
        return miss();
    };
    if require_preview(&w).is_err() {
        return miss();
    }
    let Ok(h) = state(ctx.app_handle()) else {
        return miss();
    };
    let slot = h.live.lock().unwrap_or_else(|p| p.into_inner());
    let Some(l) = slot.as_ref().filter(|l| live(ctx.app_handle(), l)) else {
        return miss();
    };
    let Some(d) = l.draft.as_ref() else {
        return miss();
    };
    let Some(rest) = request.uri().path().strip_prefix(&format!("/{}/", l.nonce)) else {
        return miss();
    };
    let Some(m) = d.moments.iter().find(|m| rest == format!("{}.jpg", m.id)) else {
        return miss();
    };
    Response::builder()
        .header("Content-Type", "image/jpeg")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(m.crop.clone())
        .unwrap_or_else(|_| miss())
}
#[tauri::command]
pub fn handoff_preview_state(window: WebviewWindow) -> Result<Value, String> {
    require_preview(&window)?;
    let app = window.app_handle();
    let h = state(app)?;
    let slot = h.live.lock().unwrap_or_else(|p| p.into_inner());
    let Some(l) = slot.as_ref().filter(|l| live(app, l)) else {
        return Ok(json!({"phase":"none"}));
    };
    let prefs = settings(app);
    let mut out = json!({"phase":l.phase,"message":l.message,"hint":l.hint,"link":l.link,"recent":prefs.recent,"expiryDays":prefs.expiry_days,"senderName":prefs.sender_name});
    if let Some(d) = &l.draft {
        out["brief"] = d.brief.to_json();
        out["names"] = json!(d.names);
        out["hidden"] = json!(d
            .found
            .iter()
            .map(|(kind, count)| json!({"kind":kind,"count":count}))
            .collect::<Vec<_>>());
        out["moments"]=json!(d.moments.iter().map(|m|json!({"id":m.id,"include":m.include,"app":m.moment.app,"window":m.moment.window,"question":m.moment.question,"at":package::iso(m.moment.at),"src":format!("mewhandoff://localhost/{}/{}.jpg",l.nonce,m.id)})).collect::<Vec<_>>());
    }
    Ok(out)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewEdit {
    brief: Option<Value>,
    include: Option<Vec<String>>,
    hide_names: Option<bool>,
}
#[tauri::command]
pub fn handoff_preview_update(window: WebviewWindow, edit: PreviewEdit) -> Result<(), String> {
    require_preview(&window)?;
    let app = window.app_handle();
    let h = state(app)?;
    let mut slot = h.live.lock().unwrap_or_else(|p| p.into_inner());
    let d = slot
        .as_mut()
        .filter(|l| live(app, l) && l.phase == "ready")
        .and_then(|l| l.draft.as_mut())
        .ok_or("Nothing to edit.")?;
    if let Some(include) = edit.include {
        for m in &mut d.moments {
            m.include = include.contains(&m.id);
        }
    }
    if let Some(b) = edit.brief {
        let ids = d.moments.iter().map(|m| m.id.clone()).collect::<Vec<_>>();
        let (b, f) = Brief::checked(&b, &ids).ok_or("The brief isn't valid.")?;
        d.brief = b;
        redact::merge(&mut d.found, &f);
    }
    if edit.hide_names == Some(true) {
        package::hide_names(d);
    }
    Ok(())
}
#[tauri::command]
pub async fn handoff_preview_blur(
    window: WebviewWindow,
    moment: String,
    rect: [u32; 4],
) -> Result<(), String> {
    require_preview(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let h = state(&app)?;
        let mut slot = h.live.lock().unwrap_or_else(|p| p.into_inner());
        let d = slot
            .as_mut()
            .filter(|l| live(&app, l) && l.phase == "ready")
            .and_then(|l| l.draft.as_mut())
            .ok_or("Nothing to edit.")?;
        let m = d
            .moments
            .iter_mut()
            .find(|m| m.id == moment)
            .ok_or("No such moment.")?;
        let [l, t, r, b] = rect;
        let cover = [l.min(r), t.min(b), l.max(r), t.max(b)];
        let bytes = crypto::image(&m.crop, Some(cover), 2400).ok_or("Couldn't hide that area.")?;
        wipe(&mut m.crop);
        m.crop = bytes.as_slice().to_vec();
        *d.found.entry(Kind::Custom).or_insert(0) += 1;
        Ok(())
    })
    .await
    .map_err(|_| "Couldn't edit the image.".to_owned())?
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendRequest {
    recipients: Vec<String>,
    expiry_days: u32,
    sender_name: String,
}
#[tauri::command]
pub async fn handoff_preview_send(
    window: WebviewWindow,
    send: SendRequest,
) -> Result<String, String> {
    require_preview(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || send_draft(&app, send))
        .await
        .map_err(|_| "Handoff send stopped.".to_owned())?
}
fn send_draft(app: &AppHandle, send: SendRequest) -> Result<String, String> {
    let recipients = validated_recipients(send.recipients)?;
    if ![1, 7, 30].contains(&send.expiry_days) {
        return Err("Choose an expiry of 1, 7 or 30 days.".into());
    }
    let sender = send
        .sender_name
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect::<String>();
    let h = state(app)?;
    let (mut d, stamp, revision, generation) = {
        let mut slot = h.live.lock().unwrap_or_else(|p| p.into_inner());
        let l = slot
            .as_mut()
            .filter(|l| live(app, l) && l.phase == "ready")
            .ok_or("Nothing to send.")?;
        l.phase = "sending";
        (
            l.draft.clone().ok_or("Nothing to send.")?,
            l.stamp,
            l.revision,
            l.generation,
        )
    };
    d.sender_name = if sender.is_empty() {
        "A teammate".into()
    } else {
        sender
    };
    let result = (|| {
        let plain = SecretBytes::from_vec(package::plaintext(&d));
        let mut key = SecretBytes::zeroed(32);
        getrandom::fill(key.as_mut_slice()).map_err(|_| "Couldn't make an encryption key.")?;
        let sealed = crypto::seal(
            key.as_slice()
                .try_into()
                .map_err(|_| "Invalid encryption key.")?,
            plain.as_slice(),
        )
        .ok_or("Couldn't encrypt the handoff.")?;
        if sealed.len() > 25 * 1024 * 1024 {
            return Err("This Handoff is over 25 MB. Leave out a moment or two.".into());
        }
        let cancelled = || !current(app, revision, generation);
        let create=SecretBytes::from_vec(serde_json::to_vec(&json!({"title":d.brief.title,"senderName":d.sender_name,"recipients":recipients.iter().map(|e|json!({"email":e})).collect::<Vec<_>>(),"expiresInDays":send.expiry_days,"sizeBytes":sealed.len(),"contentKey":base64::encode(key.as_slice())})).map_err(|_|"Couldn't prepare Handoff.")?);
        let created =
            service_call::post_bound(app, "api/handoff", create.as_slice(), &stamp, &cancelled)
                .map_err(|e| e.to_string())?;
        let created: Value = serde_json::from_slice(created.as_slice())
            .map_err(|_| "Neb sent an invalid Handoff reply.")?;
        let id = created["id"]
            .as_str()
            .filter(|s| protocol::is_uuid(s))
            .ok_or("Neb sent an invalid Handoff id.")?;
        let link = created["link"]
            .as_str()
            .ok_or("Neb sent no Handoff link.")?;
        let sign = app
            .try_state::<SignIn>()
            .ok_or("Account services aren't ready.")?;
        let url = Url::parse(link).map_err(|_| "Neb sent an invalid Handoff link.")?;
        if url.origin() != sign.app_url().origin() || url.path() != format!("/h/{id}") {
            return Err("Neb sent a Handoff link for a different app.".into());
        }
        service_call::post_bytes_bound(
            app,
            &format!("api/handoff/{id}/package"),
            sealed.as_slice(),
            "application/octet-stream",
            4096,
            &stamp,
            &cancelled,
        )
        .map_err(|e| e.to_string())?;
        service_call::post_bound(
            app,
            &format!("api/handoff/{id}/finalize"),
            b"{}",
            &stamp,
            &cancelled,
        )
        .map_err(|e| e.to_string())?;
        if cancelled() || service_call::credential_stamp(app).ok() != Some(stamp) {
            return Err("The Handoff send was cancelled.".into());
        }
        Ok(link.to_owned())
    })();
    if let Ok(link) = &result {
        let _ = runtime::of(app)?.update(|c| {
            c.handoff.sender_name = d.sender_name.clone();
            c.handoff.expiry_days = send.expiry_days;
            for recipient in recipients.iter().rev() {
                c.handoff.recent.retain(|r| r != recipient);
                c.handoff.recent.insert(0, recipient.clone());
            }
            c.handoff.recent.truncate(10);
            Ok(())
        });
        if let Some(l) = h
            .live
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_mut()
            .filter(|l| l.revision == revision)
        {
            l.phase = "sent";
            l.link = Some(link.clone());
            l.draft = None;
            l.generation = runtime::of(app)?.generation.load(Ordering::Acquire);
        }
    } else if let Some(l) = h
        .live
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_mut()
        .filter(|l| l.revision == revision)
    {
        l.phase = "ready";
    }
    result
}
fn validated_recipients(input: Vec<String>) -> Result<Vec<String>, String> {
    let mut result = vec![];
    for email in input {
        let email = email.trim().to_lowercase();
        if email.is_empty() {
            continue;
        }
        if email.len() > 254
            || email.chars().any(|c| c.is_whitespace() || c.is_control())
            || !email.split_once('@').is_some_and(|(a, b)| {
                !a.is_empty()
                    && b.contains('.')
                    && !b.starts_with('.')
                    && !b.ends_with('.')
                    && !b.contains('@')
            })
        {
            return Err("Add a valid recipient email.".into());
        }
        if !result.contains(&email) {
            result.push(email);
        }
    }
    if result.is_empty() || result.len() > 5 {
        return Err("Add one to five recipient emails.".into());
    }
    Ok(result)
}
fn dialog(title: &str, prompt: &str, button: &str, current: &dyn Fn() -> bool) -> bool {
    chores::native(
        &["dialog".into(), title.into(), prompt.into(), button.into()],
        current,
        Duration::from_secs(120),
    )
    .ok()
    .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    .and_then(|v| v["confirmed"].as_bool())
        == Some(true)
}
fn copy(text: &str, current: &dyn Fn() -> bool) -> Result<(), String> {
    let reply = chores::native(
        &["copy".into(), text.into()],
        current,
        Duration::from_secs(5),
    )?;
    if serde_json::from_slice::<Value>(&reply)
        .ok()
        .and_then(|v| v["ok"].as_bool())
        == Some(true)
    {
        Ok(())
    } else {
        Err("Couldn't copy it.".into())
    }
}
#[tauri::command]
pub async fn handoff_preview_copy(window: WebviewWindow, text: String) -> Result<(), String> {
    require_preview(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (stamp, revision, generation) = {
            let h = state(&app)?;
            let slot = h.live.lock().unwrap_or_else(|p| p.into_inner());
            let l = slot
                .as_ref()
                .filter(|l| live(&app, l) && l.link.as_deref() == Some(text.as_str()))
                .ok_or("No sent link to copy.")?;
            (l.stamp, l.revision, l.generation)
        };
        if service_call::credential_stamp(&app).ok() != Some(stamp) {
            return Err("The account changed.".into());
        }
        copy(&text, &|| current(&app, revision, generation))
    })
    .await
    .map_err(|_| "Couldn't copy Handoff link.".to_owned())?
}
#[tauri::command]
pub fn handoff_preview_cancel(window: WebviewWindow) -> Result<(), String> {
    require_preview(&window)?;
    cancel_all(window.app_handle());
    let _ = window.close();
    Ok(())
}
pub fn parse_link(url: &Url) -> Option<String> {
    if url.scheme() != "neb"
        || url.host_str() != Some("handoff")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let id = url.path().strip_prefix('/')?;
    protocol::is_uuid(id).then(|| id.to_lowercase())
}
pub fn open_link(app: &AppHandle, id: &str) {
    if !protocol::is_uuid(id) {
        return;
    }
    if let (Some(sign), Some(main)) = (
        app.try_state::<SignIn>(),
        app.get_webview_window(crate::MAIN),
    ) {
        if let Ok(url) = sign.app_url().join(&format!("/h/{id}")) {
            let _ = main.navigate(url);
            let _ = main.show();
            let _ = main.set_focus();
        }
    }
}
#[tauri::command]
pub async fn handoff_pick_up(window: WebviewWindow, id: String) -> Result<(), String> {
    let app = window.app_handle().clone();
    let sign = app
        .try_state::<SignIn>()
        .ok_or("Account services aren't ready.")?;
    crate::screen::page::require_app_page(&window, sign.app_url())?;
    if !protocol::is_uuid(&id) {
        return Err("That isn't a Handoff.".into());
    }
    tauri::async_runtime::spawn_blocking(move || pick_up(&app, &id))
        .await
        .map_err(|_| "Handoff pickup stopped.".to_owned())?
}
fn pick_up(app: &AppHandle, id: &str) -> Result<(), String> {
    let stamp = service_call::credential_stamp(app).map_err(|e| e.to_string())?;
    let generation = runtime::of(app)?.generation.load(Ordering::Acquire);
    let serial = state(app)?.revision.load(Ordering::Acquire);
    let valid = || {
        current(app, serial, generation) && service_call::credential_stamp(app).ok() == Some(stamp)
    };
    let reply = service_call::post_bound(
        app,
        &format!("api/handoff/{id}/device"),
        b"{}",
        &stamp,
        &|| !valid(),
    )
    .map_err(|e| e.to_string())?;
    let view: Value =
        serde_json::from_slice(reply.as_slice()).map_err(|_| "Invalid Handoff reply.")?;
    let key = SecretBytes::from_vec(
        view["contentKey"]
            .as_str()
            .and_then(base64::decode)
            .filter(|b| b.len() == 32)
            .ok_or("Invalid Handoff encryption key.")?,
    );
    let sealed = service_call::post_bytes_bound(
        app,
        &format!("api/handoff/{id}/device/package"),
        b"{}",
        "application/json",
        30 * 1024 * 1024,
        &stamp,
        &|| !valid(),
    )
    .map_err(|e| e.to_string())?;
    let plain = crypto::open(
        key.as_slice().try_into().map_err(|_| "Invalid key.")?,
        sealed.as_slice(),
    )
    .ok_or("The Handoff could not be authenticated.")?;
    let parsed: Value =
        serde_json::from_slice(plain.as_slice()).map_err(|_| "Invalid Handoff package.")?;
    if parsed["manifest"]["version"] != 1 {
        return Err("This Handoff version isn't supported.".into());
    }
    let home = home()?;
    let actions = pickup::plan(
        &parsed["manifest"],
        |s| allowed_file(Path::new(s), &home),
        |name| local_repo(name, &home),
    );
    if actions.is_empty() {
        return Err("There is nothing to reopen on this Mac.".into());
    }
    let summary = actions
        .iter()
        .map(describe)
        .collect::<Vec<_>>()
        .join("\n• ");
    if !dialog(
        "Pick up from here?",
        &format!("Neb asks before each step:\n• {summary}\n\nCommands are only copied."),
        "Pick up",
        &valid,
    ) {
        return Ok(());
    }
    for action in actions {
        if !valid() {
            return Err("The pickup was cancelled.".into());
        }
        run_action(app, action, &home, &valid)?;
    }
    Ok(())
}
fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .and_then(|p| PathBuf::from(p).canonicalize().ok())
        .ok_or_else(|| "Couldn't locate your folders.".into())
}
fn allowed_file(path: &Path, home: &Path) -> bool {
    path.is_absolute()
        && path
            .canonicalize()
            .is_ok_and(|p| p.starts_with(home) && p.is_file())
}
fn local_repo(name: &str, home: &Path) -> Option<String> {
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', ':']) {
        return None;
    }
    [
        "IdeaProjects",
        "Documents/GitHub",
        "code",
        "projects",
        "dev",
        "repos",
        "",
    ]
    .iter()
    .map(|p| home.join(p).join(name))
    .filter_map(|p| p.canonicalize().ok())
    .find(|p| p.starts_with(home) && p.join(".git").exists())
    .map(|p| p.to_string_lossy().into_owned())
}
fn describe(a: &Action) -> String {
    match a {
        Action::OpenFile(p) => format!("Open {p}"),
        Action::OpenUrl(u) => format!("Open {u}"),
        Action::Git { repo, branch } => format!("Switch {repo} to {branch}"),
        Action::Next { text, kind, .. } if kind == "command" => {
            format!("Copy a command for: {text}")
        }
        Action::Next { text, .. } => format!("Next: {text}"),
    }
}
fn run_action(
    app: &AppHandle,
    action: Action,
    home: &Path,
    valid: &dyn Fn() -> bool,
) -> Result<(), String> {
    match action {
        Action::OpenFile(path) => {
            if allowed_file(Path::new(&path), home)
                && dialog("Open this file?", &path, "Open", valid)
            {
                let canonical = Path::new(&path)
                    .canonicalize()
                    .map_err(|_| "The file moved.")?;
                if !allowed_file(&canonical, home) {
                    return Err("The file moved outside your folders.".into());
                }
                chores::native(
                    &[
                        "open".into(),
                        canonical.to_string_lossy().into_owned(),
                        if super::chores::reveal_only(&canonical) {
                            "reveal"
                        } else {
                            "open"
                        }
                        .into(),
                    ],
                    valid,
                    Duration::from_secs(5),
                )?;
            }
        }
        Action::OpenUrl(url) => {
            let parsed = Url::parse(&url).map_err(|_| "Invalid page address.")?;
            if parsed.scheme() != "https"
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err("Only ordinary HTTPS pages can reopen.".into());
            }
            if dialog("Open this page?", &url, "Open", valid) {
                chores::native(&["open_url".into(), url], valid, Duration::from_secs(5))?;
            }
        }
        Action::Git { repo, branch } => switch_branch(&repo, &branch, home, valid)?,
        Action::Next { text, kind, target } => {
            if kind == "command" {
                if let Some(command) = target.filter(|c| !c.is_empty() && c.len() <= 2000) {
                    if dialog(
                        "Command for you to review",
                        &format!(
                            "{text}\n\n{command}\n\nNeb copies this command; it never runs it."
                        ),
                        "Copy command",
                        valid,
                    ) {
                        copy(&command, valid)?;
                    }
                }
            } else if kind == "click" {
                if dialog("Show the next step?", &text, "Show me", valid) {
                    let _ = super::hand::route_words(app, &format!("show me {text}"));
                }
            } else {
                dialog("Next step", &text, "Continue", valid);
            }
        }
    }
    Ok(())
}
fn git_run(repo: &Path, step: &GitStep, valid: &dyn Fn() -> bool) -> Option<String> {
    if !valid() {
        return None;
    }
    let mut child = Command::new("/usr/bin/git")
        .arg("-C")
        .arg(repo)
        .args(step.args())
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    let out = child.stdout.take()?;
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = out.take(256 * 1024 + 1).read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let started = Instant::now();
    let mut output = None;
    let result = loop {
        if !valid() || started.elapsed() > Duration::from_secs(30) {
            break None;
        }
        if output.is_none() {
            if let Ok(bytes) = rx.try_recv() {
                if bytes.len() > 256 * 1024 {
                    break None;
                }
                output = Some(bytes);
            }
        }
        match child.try_wait() {
            Ok(Some(s)) if !s.success() => break None,
            Ok(Some(_)) if output.is_some() => {
                break String::from_utf8(output.take().unwrap()).ok()
            }
            Err(_) => break None,
            _ => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    if result.is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    result
}
fn switch_branch(
    repo: &str,
    branch: &str,
    home: &Path,
    valid: &dyn Fn() -> bool,
) -> Result<(), String> {
    if !pickup::safe_branch(branch) {
        return Err("Invalid branch name.".into());
    }
    let path = Path::new(repo)
        .canonicalize()
        .map_err(|_| "Repository moved.")?;
    if !path.starts_with(home) || !path.join(".git").exists() {
        return Err("Repository is outside your folders.".into());
    }
    let status =
        git_run(&path, &GitStep::Status, valid).ok_or("Couldn't read repository state.")?;
    if git_run(&path, &GitStep::Current, valid).is_some_and(|b| b.trim() == branch) {
        return Ok(());
    }
    let dirty = !status.trim().is_empty();
    let prompt = if dirty {
        format!("{repo}\n\nKeep your changes in a stash, then switch to {branch} and pull fast-forward only?")
    } else {
        format!("{repo}\n\nSwitch to {branch} and pull fast-forward only?")
    };
    if !dialog(
        "Switch repository branch?",
        &prompt,
        if dirty { "Stash and switch" } else { "Switch" },
        valid,
    ) {
        return Ok(());
    }
    for step in pickup::git_steps(branch, dirty, dirty).ok_or("Invalid branch operation.")? {
        git_run(&path, &step, valid).ok_or(
            "Git stopped; no further pickup steps were run. Your stash, if created, was kept.",
        )?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn links_are_strict_and_cannot_add_authority() {
        let good = "neb://handoff/11111111-1111-4111-8111-111111111111";
        assert!(parse_link(&Url::parse(good).unwrap()).is_some());
        for bad in [
            format!("{good}?x=y"),
            format!("{good}/"),
            good.replace("neb://", "neb://user@"),
            good.replace("handoff/", "handoff:42/"),
        ] {
            assert!(parse_link(&Url::parse(&bad).unwrap()).is_none());
        }
    }
    #[test]
    fn recipients_are_bounded_and_reject_header_controls() {
        assert_eq!(
            validated_recipients(vec![" A@Example.com ".into(), "a@example.com".into()]).unwrap(),
            vec!["a@example.com"]
        );
        for input in [
            vec![],
            vec!["a@b.com\r\nBcc:x@y.com".into()],
            vec!["not-an-email".into()],
            (0..6).map(|n| format!("a{n}@b.com")).collect(),
        ] {
            assert!(validated_recipients(input).is_err());
        }
    }
    #[test]
    fn local_repos_cannot_escape_through_remote_names() {
        let home = Path::new("/synthetic/home");
        for name in ["../evil", "/tmp/repo", "a/b", ".hidden", "file:repo"] {
            assert!(local_repo(name, home).is_none());
        }
    }
}
