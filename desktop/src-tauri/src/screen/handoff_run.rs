//! Handoff on the desktop at run time (docs/HANDOFF_FEATURE.md; being built).
//!
//! - **The session timeline** (on only when the student turns it on in Settings):
//!   each saved moment (`record_moment`, from `clip.rs`, already redacted on screen) and a context
//!   snapshot of the app in front when it changes (at most one every 20 s), each record encrypted
//!   with DPAPI in the app's local data folder, kept 24 hours. Blocked apps and private windows are
//!   never recorded.
//! - **Hand off…** (the tray, or "hand this off to Rahbir"): the last 90 minutes become a draft
//!   (the key moments, every text redacted, the brief from one model call), shown in the local
//!   preview window. Nothing leaves the computer until the sender presses Send; then the package
//!   is encrypted here (AES-256-GCM, a fresh content key) and only ciphertext is uploaded.
//! - **Pick up from here** (the web page's button, or a `neb://handoff/<id>` link): the package
//!   is fetched and opened here, the steps are listed and each is confirmed; files and pages
//!   reopen, git switches branch (stashing first if asked, never discarding), commands are only
//!   copied, and a click step is shown with SHOW ME's ghost path.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::http::{Request, Response, StatusCode};
use tauri::{
    AppHandle, Manager, Runtime, UriSchemeContext, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use windows::Win32::Foundation::HWND;

use super::coach::{self, ScreenCoach};
use super::device_call::{self, CallError};
use super::handoff::context::{is_editor_or_terminal, parse_git, paths_in, repo_of, READ_ONLY};
use super::handoff::package::{self, Brief, Draft, DraftMoment};
use super::handoff::pickup::{self, Action, GitStep};
use super::handoff::redact::{self, Found, Kind};
use super::handoff::select;
pub use super::handoff::settings::HandoffSettings;
use super::handoff::timeline::{self, Event, Moment, Snapshot};
use super::privacy::blocklist::is_blocked;
use super::privacy::private_window::{is_browser, is_private_window};
use super::win::{chores, git, handoff_crypto, handoff_image, launch, target, uia};

pub const WINDOW: &str = "handoff";
pub const SCHEME: &str = "mewhandoff";
const PAGE: &str = "handoff.html";
const TIMELINE_FILE: &str = "handoff-timeline.bin";
const MAX_RECORD_BYTES: usize = 3_000_000;

/// What's in progress: the draft in the preview.
#[derive(Default)]
pub struct HandoffState {
    draft: Mutex<Option<Live>>,
    file: Mutex<()>,
    last_snapshot: Mutex<Option<i64>>,
}

struct Live {
    nonce: String,
    phase: Phase,
    draft: Option<Draft>,
    hint: Option<String>,
    link: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
enum Phase {
    Building,
    Ready,
    Empty,
    Failed(String),
    Sent,
}

fn now_s() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    app.manage(HandoffState::default());
    watch_focus(app);
}

fn handoff_state<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::State<'_, HandoffState>> {
    app.try_state::<HandoffState>()
}

pub fn settings<R: Runtime>(app: &AppHandle<R>) -> HandoffSettings {
    coach::handoff_settings(app)
}

// ─── The timeline ───────────────────────────────────────────────────────────────────────────

fn timeline_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join(TIMELINE_FILE))
}

/// Appends one encrypted record (one line: base64 of the DPAPI-protected JSON).
fn append<R: Runtime>(app: &AppHandle<R>, event: &Event) {
    let (Some(path), Some(state)) = (timeline_path(app), handoff_state(app)) else {
        return;
    };
    let Ok(json) = serde_json::to_vec(event) else {
        return;
    };
    if json.len() > MAX_RECORD_BYTES {
        return;
    }
    let Some(sealed) = handoff_crypto::protect(&json) else {
        return;
    };
    let _guard = state.file.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{}", super::base64::encode(&sealed));
    }
}

/// The last 24 hours, decrypted (older records are dropped from the file as it's read).
fn load<R: Runtime>(app: &AppHandle<R>) -> Vec<Event> {
    let (Some(path), Some(state)) = (timeline_path(app), handoff_state(app)) else {
        return Vec::new();
    };
    let _guard = state.file.lock().unwrap_or_else(|p| p.into_inner());
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let lines: Vec<&str> = text.lines().collect();
    let events: Vec<Event> = lines
        .iter()
        .filter_map(|l| super::base64::decode(l))
        .filter_map(|b| handoff_crypto::unprotect(&b))
        .filter_map(|b| serde_json::from_slice::<Event>(&b).ok())
        .collect();
    let kept = timeline::keep_recent(events, now_s());
    if kept.len() < lines.len() {
        let rewritten: String = kept
            .iter()
            .filter_map(|e| serde_json::to_vec(e).ok())
            .filter_map(|j| handoff_crypto::protect(&j))
            .map(|s| format!("{}\n", super::base64::encode(&s)))
            .collect();
        let temp = path.with_extension("tmp");
        if fs::write(&temp, rewritten).is_ok() {
            let _ = fs::rename(&temp, &path);
        }
    }
    kept
}

/// Wipes the timeline (turning it off).
pub fn forget_timeline<R: Runtime>(app: &AppHandle<R>) {
    if let Some(path) = timeline_path(app) {
        let _ = fs::remove_file(path);
    }
}

fn recording<R: Runtime>(app: &AppHandle<R>) -> bool {
    coach::is_usable(app) && settings(app).timeline
}

/// Whether saved moments go into the timeline now.
pub fn wants_moments<R: Runtime>(app: &AppHandle<R>) -> bool {
    recording(app)
}

/// A clip being saved, as a timeline moment: its picture with every sensitive word covered
/// (Handoff's rules, stricter than the student's own), its question, explanation and marks.
pub fn record_clip<R: Runtime>(
    app: &AppHandle<R>,
    small: &super::image::Pixels,
    head: &super::protocol::ClipHead,
    on_screen: super::frame::ScreenRect,
    text: &super::screen_text::ScreenText,
    window: Option<isize>,
) {
    let (w, h) = (small.width, small.height);
    let (sw, sh) = (
        on_screen.width().max(1) as f64,
        on_screen.height().max(1) as f64,
    );
    let boxes: Vec<super::privacy::redact::PixelRect> = text
        .handoff_covers(on_screen)
        .into_iter()
        .map(|r| {
            let x = |v: i32| {
                ((f64::from(v - on_screen.left) * f64::from(w) / sw).clamp(0.0, f64::from(w)))
                    as u32
            };
            let y = |v: i32| {
                ((f64::from(v - on_screen.top) * f64::from(h) / sh).clamp(0.0, f64::from(h))) as u32
            };
            super::privacy::redact::PixelRect {
                left: x(r.left),
                top: y(r.top),
                right: x(r.right) + 2,
                bottom: y(r.bottom) + 2,
            }
        })
        .collect();
    let Ok(base) = super::win::encode::encode_jpeg_with(small, super::win::encode::FOR_CLIP) else {
        return;
    };
    let crop = if boxes.is_empty() {
        base.as_slice().to_vec()
    } else {
        match handoff_image::cover(base.as_slice(), &boxes) {
            Some(c) => c,
            None => return,
        }
    };
    let turn = head.entry.as_ref().map(|e| &e.turn);
    let moment = Moment {
        at: now_s(),
        app: head.source.app.clone(),
        window: head.source.title.clone().unwrap_or_default(),
        jpeg: super::base64::encode(&crop),
        width: w,
        height: h,
        question: turn
            .map(|t| t.question.clone())
            .filter(|q| !q.trim().is_empty()),
        explanation: turn
            .map(|t| t.steps.join(" "))
            .filter(|e| !e.trim().is_empty()),
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
    record_moment(app, moment, window);
}

/// A saved moment (from `clip.rs`, its crop already covered for Handoff).
pub fn record_moment<R: Runtime>(app: &AppHandle<R>, moment: Moment, window: Option<isize>) {
    if !recording(app) {
        return;
    }
    let blocked = coach::privacy_of(app).blocked_apps;
    if is_blocked(&moment.app, &blocked) || is_private_window(&moment.app, &moment.window) {
        return;
    }
    append(app, &Event::Moment(moment));
    if let Some(w) = window {
        snapshot_now(app, HWND(w as *mut _), true);
    }
}

/// A snapshot of `hwnd` (debounced unless `force`), recorded when it may be.
fn snapshot_now<R: Runtime>(app: &AppHandle<R>, hwnd: HWND, force: bool) -> Option<Snapshot> {
    let now = now_s();
    if let Some(state) = handoff_state(app) {
        let mut last = state
            .last_snapshot
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if !force && !timeline::snapshot_due(*last, now) {
            return None;
        }
        *last = Some(now);
    }
    let blocked = coach::privacy_of(app).blocked_apps;
    let snap = snapshot_of(hwnd, &blocked, now)?;
    if recording(app) {
        append(app, &Event::Snapshot(snap.clone()));
    }
    Some(snap)
}

/// What the window in front shows: app, title, page, a path and its git state (read-only).
fn snapshot_of(hwnd: HWND, blocked: &[String], now: i64) -> Option<Snapshot> {
    let app = target::exe_name_of(hwnd)?;
    let title = target::window_title(hwnd);
    if is_blocked(&app, blocked)
        || is_private_window(&app, &title)
        || app == "mew-desktop.exe"
        || app == "neb.exe"
    {
        return None;
    }
    let url = is_browser(&app)
        .then(|| uia::Automation::new().ok()?.address_bar(hwnd))
        .flatten()
        .map(|u| redact::strip_secret_params(&u));
    let path = paths_in(&title).into_iter().next();
    let git = path
        .as_deref()
        .filter(|_| is_editor_or_terminal(&app))
        .and_then(|p| repo_of(Path::new(p), git::has_git))
        .and_then(|repo| {
            let run = |args: &[&str]| {
                let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
                git::run(&repo, &args, Duration::from_secs(2))
            };
            let branch = run(READ_ONLY[0])?;
            Some(parse_git(
                &repo,
                &branch,
                &run(READ_ONLY[1]).unwrap_or_default(),
                &run(READ_ONLY[2]).unwrap_or_default(),
                &run(READ_ONLY[3]).unwrap_or_default(),
            ))
        });
    let document = title
        .split(" - ")
        .next()
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(str::to_owned);
    Some(Snapshot {
        at: now,
        app,
        window: title.chars().take(200).collect(),
        document,
        selection: None,
        url,
        git,
        terminal: Vec::new(),
        path,
    })
}

/// Snapshots on focus changes (the WinEvent foreground hook), while the timeline is on.
fn watch_focus<R: Runtime>(app: &AppHandle<R>) {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, TranslateMessage, EVENT_SYSTEM_FOREGROUND, MSG,
        WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
    };
    static SENDER: Mutex<Option<std::sync::mpsc::Sender<isize>>> = Mutex::new(None);
    unsafe extern "system" fn on_foreground(
        _: HWINEVENTHOOK,
        _: u32,
        hwnd: HWND,
        _: i32,
        _: i32,
        _: u32,
        _: u32,
    ) {
        if let Some(tx) = SENDER.lock().ok().and_then(|s| s.clone()) {
            let _ = tx.send(hwnd.0 as isize);
        }
    }
    let (tx, rx) = std::sync::mpsc::channel::<isize>();
    *SENDER.lock().unwrap_or_else(|p| p.into_inner()) = Some(tx);
    let handle = app.clone();
    // The worker that takes the snapshots (UI Automation, git), off the hook's thread.
    let _ = std::thread::Builder::new()
        .name("mew-handoff-snapshots".into())
        .spawn(move || {
            // SAFETY: COM for this thread (UI Automation).
            let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            while let Ok(hwnd) = rx.recv() {
                if recording(&handle) {
                    let _ = snapshot_now(&handle, HWND(hwnd as *mut _), false);
                }
            }
        });
    let _ = std::thread::Builder::new()
        .name("mew-handoff-focus".into())
        .spawn(|| {
            // SAFETY: an out-of-context hook with a valid callback, on this thread's message loop.
            let hook = unsafe {
                SetWinEventHook(
                    EVENT_SYSTEM_FOREGROUND,
                    EVENT_SYSTEM_FOREGROUND,
                    None,
                    Some(on_foreground),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                )
            };
            if hook.is_invalid() {
                return;
            }
            let mut msg = MSG::default();
            // SAFETY: the standard message loop of a thread we own (it runs for the app's life).
            unsafe {
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        });
}

/// The timeline's contents for the settings page's debug view: kinds, apps and times only.
pub fn debug_view<R: Runtime>(app: &AppHandle<R>) -> Value {
    let events = load(app);
    let rows: Vec<Value> = events
        .iter()
        .rev()
        .take(50)
        .map(|e| match e {
            Event::Moment(m) => json!({ "kind": "moment", "at": package::iso(m.at), "app": m.app }),
            Event::Snapshot(s) => json!({
                "kind": "snapshot", "at": package::iso(s.at), "app": s.app,
                "git": s.git.is_some(), "url": s.url.is_some(),
            }),
        })
        .collect();
    json!({ "count": events.len(), "recent": rows })
}

// ─── Hand off… ──────────────────────────────────────────────────────────────────────────────

/// "Hand this off to Rahbir" or the tray: builds the draft and opens the preview.
pub fn start<R: Runtime>(app: &AppHandle<R>, hint: Option<String>) {
    if !coach::is_usable(app) {
        coach::notify(app, "Turn Screen Coach on to hand off your work.");
        return;
    }
    if !settings(app).timeline {
        coach::notify(app, "Handoff (being built) needs its timeline: Settings → Handoff → keep a 24-hour timeline.");
        coach::open_settings(app);
        return;
    }
    let Some(state) = handoff_state(app) else {
        return;
    };
    let nonce = match super::win::crypto::random_bytes::<16>() {
        Ok(b) => b.iter().map(|x| format!("{x:02x}")).collect::<String>(),
        Err(_) => return,
    };
    *state.draft.lock().unwrap_or_else(|p| p.into_inner()) = Some(Live {
        nonce,
        phase: Phase::Building,
        draft: None,
        hint: hint.clone(),
        link: None,
    });
    open_window(app);
    let handle = app.clone();
    let _ = std::thread::Builder::new()
        .name("mew-handoff-build".into())
        .spawn(move || {
            use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
            // SAFETY: COM for this thread (UI Automation, WIC).
            let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            let phase = build(&handle, hint.as_deref());
            if let Some(state) = handoff_state(&handle) {
                if let Some(live) = state
                    .draft
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .as_mut()
                {
                    match phase {
                        Ok(Some(draft)) => {
                            live.draft = Some(draft);
                            live.phase = Phase::Ready;
                        }
                        Ok(None) => live.phase = Phase::Empty,
                        Err(message) => live.phase = Phase::Failed(message),
                    }
                }
            }
        });
}

fn open_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.eval("window.dispatchEvent(new Event('handoff:changed'))");
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let dev_url = app.config().build.dev_url.clone();
    let built = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App(PAGE.into()))
        .title("Neb · Hand off (being built)")
        .inner_size(1040.0, 760.0)
        .min_inner_size(720.0, 520.0)
        .additional_browser_args(crate::BROWSER_ARGS)
        .on_navigation(move |url| super::is_local_page(url, dev_url.as_ref()))
        .build();
    if let Err(error) = built {
        eprintln!("[handoff] couldn't open the preview ({error})");
    }
}

/// The draft from the timeline: key moments, redacted texts, the brief (one model call; a plain
/// one from the moments' own words if it can't be made). Ok(None): nothing in the window.
fn build<R: Runtime>(app: &AppHandle<R>, hint: Option<&str>) -> Result<Option<Draft>, String> {
    let prefs = settings(app);
    let now = now_s();
    if let Some(front) = target::foreground_app_window() {
        let _ = snapshot_now(app, front, true);
    }
    let events = load(app);
    let (moments, snapshots) = select::session(&events, now, prefs.window_min);
    if moments.is_empty() && snapshots.is_empty() {
        return Ok(None);
    }
    let key = select::key_moments(&moments, now);
    let mut found = Found::new();
    let draft_moments: Vec<DraftMoment> = key
        .iter()
        .enumerate()
        .map(|(n, &i)| {
            let m = package::redact_moment(&moments[i], &mut found);
            DraftMoment {
                id: format!("m{}", n + 1),
                include: true,
                crop: super::base64::decode(&moments[i].jpeg).unwrap_or_default(),
                moment: Moment {
                    jpeg: String::new(),
                    ..m
                },
            }
        })
        .collect();
    let snapshots: Vec<Snapshot> = snapshots
        .iter()
        .map(|s| package::redact_snapshot(s, &mut found))
        .collect();
    let sender_name = if prefs.sender_name.is_empty() {
        "A teammate".to_owned()
    } else {
        prefs.sender_name.clone()
    };
    let all_text: String = draft_moments
        .iter()
        .flat_map(|m| [m.moment.question.clone(), m.moment.explanation.clone()])
        .flatten()
        .collect::<Vec<_>>()
        .join("\n");
    let known: Vec<&str> = [
        sender_name.split(' ').next().unwrap_or(""),
        hint.unwrap_or(""),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect();
    let names = redact::possible_names(&all_text, &known);
    let ids: Vec<String> = draft_moments.iter().map(|m| m.id.clone()).collect();
    let first = moments
        .first()
        .map_or(now, |m| m.at)
        .min(snapshots.first().map_or(now, |s| s.at));
    let mut draft = Draft {
        sender_name,
        language: "en".into(),
        created_at: package::iso(now),
        from: package::iso(first),
        to: package::iso(now),
        moments: draft_moments,
        snapshots,
        brief: Brief::default(),
        found,
        names,
    };
    // Two to four crops for the brief, the most relevant (the key moments' last four), small.
    let crops: Vec<(String, String)> = draft
        .moments
        .iter()
        .rev()
        .take(4)
        .filter_map(|m| {
            Some((
                m.id.clone(),
                super::base64::encode(&handoff_image::shrink_jpeg(&m.crop, 768)?),
            ))
        })
        .collect();
    let body = package::brief_request(&draft, &crops);
    let brief_json = device_call::post(
        app,
        "api/handoff/brief",
        "handoff-brief",
        body.to_string().as_bytes(),
    )
    .ok()
    .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    .map(|v| v["brief"].clone());
    let (brief, more) = brief_json
        .and_then(|b| Brief::checked(&b, &ids))
        .unwrap_or_else(|| (fallback_brief(&draft), Found::new()));
    redact::merge(&mut draft.found, &more);
    draft.brief = brief;
    if prefs.always_hide_names {
        package::hide_names(&mut draft);
    }
    Ok(Some(draft))
}

fn fallback_brief(draft: &Draft) -> Brief {
    let last = draft.snapshots.last();
    Brief {
        title: draft
            .moments
            .last()
            .map(|m| m.moment.window.clone())
            .or_else(|| last.map(|s| s.window.clone()))
            .unwrap_or_else(|| "Handoff".into())
            .chars()
            .take(120)
            .collect(),
        where_: last
            .map(|s| {
                format!(
                    "{} · {}",
                    s.app,
                    s.document.clone().unwrap_or_else(|| s.window.clone())
                )
            })
            .unwrap_or_default(),
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
    }
}

/// The preview's crops: `mewhandoff://localhost/<nonce>/<id>.jpg`, to the preview window only.
pub fn serve<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let not_found = || {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("Cache-Control", "no-store")
            .body(Vec::new())
            .unwrap_or_default()
    };
    if ctx.webview_label() != WINDOW || request.method() != "GET" {
        return not_found();
    }
    let Some(state) = ctx.app_handle().try_state::<HandoffState>() else {
        return not_found();
    };
    let guard = state.draft.lock().unwrap_or_else(|p| p.into_inner());
    let Some(live) = guard.as_ref() else {
        return not_found();
    };
    let Some(draft) = &live.draft else {
        return not_found();
    };
    let path = request.uri().path().to_owned();
    let Some(rest) = path.strip_prefix(&format!("/{}/", live.nonce)) else {
        return not_found();
    };
    let Some(m) = draft
        .moments
        .iter()
        .find(|m| format!("{}.jpg", m.id) == rest)
    else {
        return not_found();
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "image/jpeg")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(m.crop.clone())
        .unwrap_or_else(|_| not_found())
}

fn require_preview<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let dev_url = window.app_handle().config().build.dev_url.clone();
    let local = window
        .url()
        .is_ok_and(|u| super::is_local_page(&u, dev_url.as_ref()));
    (window.label() == WINDOW && local)
        .then_some(())
        .ok_or_else(|| "Not allowed.".to_owned())
}

/// What the preview shows.
#[tauri::command]
pub fn handoff_preview_state<R: Runtime>(window: WebviewWindow<R>) -> Result<Value, String> {
    require_preview(&window)?;
    let app = window.app_handle();
    let state = handoff_state(app).ok_or("Not ready.")?;
    let prefs = settings(app);
    let guard = state.draft.lock().unwrap_or_else(|p| p.into_inner());
    let Some(live) = guard.as_ref() else {
        return Ok(json!({ "phase": "none" }));
    };
    let (phase, message) = match &live.phase {
        Phase::Building => ("building", None),
        Phase::Ready => ("ready", None),
        Phase::Empty => ("empty", None),
        Phase::Failed(m) => ("failed", Some(m.clone())),
        Phase::Sent => ("sent", None),
    };
    let mut out = json!({
        "phase": phase, "message": message, "hint": live.hint, "link": live.link,
        "recent": prefs.recent, "expiryDays": prefs.expiry_days, "senderName": prefs.sender_name,
    });
    if let Some(d) = &live.draft {
        out["brief"] = d.brief.to_json();
        out["names"] = json!(d.names);
        out["hidden"] = json!(d
            .found
            .iter()
            .map(|(k, n)| json!({ "kind": k, "count": n }))
            .collect::<Vec<_>>());
        out["moments"] = json!(d
            .moments
            .iter()
            .map(|m| json!({
                "id": m.id, "include": m.include, "app": m.moment.app, "window": m.moment.window,
                "question": m.moment.question, "at": package::iso(m.moment.at),
                "src": format!("http://{SCHEME}.localhost/{}/{}.jpg", live.nonce, m.id),
            }))
            .collect::<Vec<_>>());
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewEdit {
    brief: Option<Value>,
    include: Option<Vec<String>>,
    hide_names: Option<bool>,
}

/// The sender's edits: the brief (checked and redacted again), which moments go, hiding names.
#[tauri::command]
pub fn handoff_preview_update<R: Runtime>(
    window: WebviewWindow<R>,
    edit: PreviewEdit,
) -> Result<(), String> {
    require_preview(&window)?;
    let state = handoff_state(window.app_handle()).ok_or("Not ready.")?;
    let mut guard = state.draft.lock().unwrap_or_else(|p| p.into_inner());
    let draft = guard
        .as_mut()
        .and_then(|l| l.draft.as_mut())
        .ok_or("Nothing to edit.")?;
    if let Some(include) = edit.include {
        for m in &mut draft.moments {
            m.include = include.contains(&m.id);
        }
    }
    if let Some(b) = edit.brief {
        let ids: Vec<String> = draft.moments.iter().map(|m| m.id.clone()).collect();
        let (brief, found) = Brief::checked(&b, &ids).ok_or("That brief isn't valid.")?;
        redact::merge(&mut draft.found, &found);
        draft.brief = brief;
    }
    if edit.hide_names == Some(true) {
        package::hide_names(draft);
    }
    Ok(())
}

/// A blur box the sender drew on a moment (image pixels).
#[tauri::command]
pub fn handoff_preview_blur<R: Runtime>(
    window: WebviewWindow<R>,
    moment: String,
    rect: [u32; 4],
) -> Result<(), String> {
    require_preview(&window)?;
    let state = handoff_state(window.app_handle()).ok_or("Not ready.")?;
    let mut guard = state.draft.lock().unwrap_or_else(|p| p.into_inner());
    let draft = guard
        .as_mut()
        .and_then(|l| l.draft.as_mut())
        .ok_or("Nothing to edit.")?;
    let m = draft
        .moments
        .iter_mut()
        .find(|m| m.id == moment)
        .ok_or("No such moment.")?;
    let [l, t, r, b] = rect;
    let boxes = [super::privacy::redact::PixelRect {
        left: l.min(r),
        top: t.min(b),
        right: l.max(r),
        bottom: t.max(b),
    }];
    m.crop = handoff_image::cover(&m.crop, &boxes).ok_or("Couldn't hide that part.")?;
    *draft.found.entry(Kind::Custom).or_insert(0) += 1;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendRequest {
    recipients: Vec<String>,
    expiry_days: u32,
    sender_name: String,
}

/// Send: the package encrypted here, the ciphertext uploaded, the recipients told. Returns the
/// link.
#[tauri::command(async)]
pub fn handoff_preview_send<R: Runtime>(
    window: WebviewWindow<R>,
    send: SendRequest,
) -> Result<String, String> {
    require_preview(&window)?;
    let app = window.app_handle().clone();
    let recipients: Vec<String> = send
        .recipients
        .iter()
        .map(|e| e.trim().to_lowercase())
        .filter(|e| !e.is_empty())
        .collect();
    if recipients.is_empty()
        || recipients.len() > 5
        || recipients
            .iter()
            .any(|e| !e.contains('@') || e.len() > 254 || e.contains(char::is_whitespace))
    {
        return Err("Add the email of who it's for (up to five).".into());
    }
    if ![1, 7, 30].contains(&send.expiry_days) {
        return Err("Choose when it expires.".into());
    }
    let sender_name: String = send
        .sender_name
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    let sender_name = if sender_name.is_empty() {
        "A teammate".to_owned()
    } else {
        sender_name
    };
    let state = handoff_state(&app).ok_or("Not ready.")?;
    let mut draft = state
        .draft
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .and_then(|l| l.draft.clone())
        .ok_or("Nothing to send.")?;
    draft.sender_name = sender_name.clone();
    let plain = package::plaintext(&draft);
    let key: [u8; 32] = super::win::crypto::random_bytes().map_err(|_| "Couldn't make a key.")?;
    let sealed = handoff_crypto::seal(&key, &plain).ok_or("Couldn't encrypt the package.")?;
    drop(plain);
    if sealed.len() > 25 * 1024 * 1024 {
        return Err("This handoff is too large (over 25 MB). Leave out a moment or two.".into());
    }
    let create = json!({
        "title": draft.brief.title, "senderName": sender_name,
        "recipients": recipients.iter().map(|e| json!({ "email": e })).collect::<Vec<_>>(),
        "expiresInDays": send.expiry_days, "sizeBytes": sealed.len(),
        "contentKey": super::base64::encode(&key),
    });
    let words = |e: CallError| match e {
        CallError::Account(m) | CallError::Limited(m) => m,
        CallError::Busy => "Too many handoffs just now. Try again in a minute.".into(),
        CallError::Failed => {
            "Couldn't send the handoff. Check your connection and try again.".into()
        }
    };
    let created = device_call::post(
        &app,
        "api/handoff",
        "handoff-create",
        create.to_string().as_bytes(),
    )
    .map_err(words)?;
    let created: Value =
        serde_json::from_slice(&created).map_err(|_| "Neb sent an unexpected reply.")?;
    let id = created["id"]
        .as_str()
        .filter(|i| is_uuid(i))
        .ok_or("Neb sent an unexpected reply.")?
        .to_owned();
    let link = created["link"].as_str().unwrap_or_default().to_owned();
    device_call::post_bytes(
        &app,
        &format!("api/handoff/{id}/package"),
        "handoff-package",
        &sealed,
        "application/octet-stream",
        4096,
    )
    .map_err(words)?;
    device_call::post(
        &app,
        &format!("api/handoff/{id}/finalize"),
        "handoff-finalize",
        b"{}",
    )
    .map_err(words)?;
    let _ = coach::update_handoff(&app, |h| {
        h.sender_name = sender_name.clone();
        h.expiry_days = send.expiry_days;
        for e in recipients.iter().rev() {
            h.recent.retain(|r| r != e);
            h.recent.insert(0, e.clone());
        }
        h.recent.truncate(10);
    });
    if let Some(live) = state
        .draft
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_mut()
    {
        live.phase = Phase::Sent;
        live.link = Some(link.clone());
        live.draft = None;
    }
    coach::notify(
        &app,
        &format!("Handoff sent to {} ✓", recipients.join(", ")),
    );
    Ok(link)
}

#[tauri::command]
pub fn handoff_preview_copy<R: Runtime>(
    window: WebviewWindow<R>,
    text: String,
) -> Result<(), String> {
    require_preview(&window)?;
    if !text.starts_with("https://") && !text.starts_with("http://localhost") {
        return Err("Not allowed.".into());
    }
    handoff_image::copy_text(&text)
        .then_some(())
        .ok_or_else(|| "Couldn't copy it.".into())
}

#[tauri::command]
pub fn handoff_preview_cancel<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    require_preview(&window)?;
    if let Some(state) = handoff_state(window.app_handle()) {
        *state.draft.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
    let _ = window.close();
    Ok(())
}

// ─── Pick up from here ──────────────────────────────────────────────────────────────────────

fn is_uuid(id: &str) -> bool {
    id.len() == 36
        && id.chars().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// `neb://handoff/<uuid>`, strictly: nothing else in the link is trusted.
pub fn parse_link(url: &Url) -> Option<String> {
    if url.scheme() != "neb" || url.host_str() != Some("handoff") {
        return None;
    }
    let id = url.path().trim_matches('/');
    (is_uuid(id) && url.query().is_none() && url.fragment().is_none()).then(|| id.to_lowercase())
}

/// Opens a handoff link in the main window (the viewer, with "Pick up from here").
pub fn open_link<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let (Some(coach), Some(main)) = (app.try_state::<ScreenCoach>(), crate::show(app)) else {
        return;
    };
    if let Ok(url) = coach.app_url().join(&format!("h/{id}")) {
        let _ = main.navigate(url);
    }
}

/// The web page's "Pick up from here": the desktop reads the handoff itself (the page only
/// names it), and asks before each step.
#[tauri::command(async)]
pub fn handoff_pick_up<R: Runtime>(window: WebviewWindow<R>, id: String) -> Result<(), String> {
    let app = window.app_handle().clone();
    let coach = coach::coach_of(&app)?;
    super::page::require_app_page(&window, coach.app_url())?;
    if !is_uuid(&id) {
        return Err("That isn't a handoff.".into());
    }
    let view = device_call::post(
        &app,
        &format!("api/handoff/{id}/device"),
        "handoff-view",
        b"{}",
    )
    .map_err(|_| {
        "Couldn't open the handoff on this computer. Is Screen Coach connected to your account?"
    })?;
    let view: Value = serde_json::from_slice(&view).map_err(|_| "Unexpected reply.")?;
    let key = view["contentKey"]
        .as_str()
        .and_then(super::base64::decode)
        .filter(|k| k.len() == 32)
        .ok_or("Unexpected reply.")?;
    let mut key_bytes = [0u8; 32];
    key_bytes.copy_from_slice(&key);
    let sealed = device_call::post_bytes(
        &app,
        &format!("api/handoff/{id}/device/package"),
        "handoff-package",
        b"{}",
        "application/json",
        30 * 1024 * 1024,
    )
    .map_err(|_| "Couldn't download the handoff.")?;
    let plain =
        handoff_crypto::open(&key_bytes, &sealed).ok_or("The handoff couldn't be opened.")?;
    let parsed: Value = serde_json::from_slice(&plain).map_err(|_| "The handoff isn't valid.")?;
    let manifest = &parsed["manifest"];
    let actions = pickup::plan(manifest, |p| Path::new(p).is_file(), local_repo);
    if actions.is_empty() {
        coach::notify(
            &app,
            "There's nothing to reopen from this handoff on this computer.",
        );
        return Ok(());
    }
    let list: Vec<String> = actions.iter().map(describe).collect();
    let go = chores::dialog(
        "Pick up from here?",
        &format!("Neb will ask before each step:\n• {}", list.join("\n• ")),
        Some("Neb never runs commands, deletes anything or discards your changes."),
        &[],
        "Pick up",
    );
    if go.is_none() {
        return Ok(());
    }
    for action in actions {
        run_action(&app, action);
    }
    Ok(())
}

fn describe(action: &Action) -> String {
    match action {
        Action::OpenFile(p) => format!("Open {p}"),
        Action::OpenUrl(u) => format!("Open {u}"),
        Action::Git { repo, branch } => format!("Switch {repo} to the branch {branch}"),
        Action::Next { text, kind, .. } if kind == "command" => {
            format!("Show the command for: {text}")
        }
        Action::Next { text, .. } => format!("Next: {text}"),
    }
}

/// The receiver's copy of a repo with this folder name, in the usual places.
fn local_repo(name: &str) -> Option<String> {
    if name.is_empty() || name.contains(['\\', '/', ':']) || name.starts_with('.') {
        return None;
    }
    let home = std::env::var("USERPROFILE").ok()?;
    [
        "Documents\\GitHub",
        "source\\repos",
        "code",
        "projects",
        "dev",
        "repos",
        "",
    ]
    .iter()
    .map(|base| Path::new(&home).join(base).join(name))
    .find(|p| git::has_git(p))
    .map(|p| p.to_string_lossy().to_string())
}

fn run_action<R: Runtime>(app: &AppHandle<R>, action: Action) {
    match action {
        Action::OpenFile(path) => {
            if chores::dialog("Open this file?", &path, None, &[], "Open").is_some() {
                let _ = chores::open_document(&path);
            }
        }
        Action::OpenUrl(url) => {
            if chores::dialog("Open this page?", &url, None, &[], "Open").is_some() {
                let _ = launch::open_url(&url);
            }
        }
        Action::Git { repo, branch } => switch_branch(app, &repo, &branch),
        Action::Next { text, kind, target } => {
            if kind == "command" {
                let command = target.unwrap_or_default();
                let copy = chores::dialog(
                    "Next: a command for you to run",
                    &format!("{text}\n\n{command}"),
                    Some(
                        "Neb never runs commands for you. Copy it, check it, then run it yourself.",
                    ),
                    &[],
                    "Copy command",
                );
                if copy.is_some() && !command.is_empty() {
                    let _ = handoff_image::copy_text(&command);
                }
            } else if kind == "click" {
                // SHOW ME's ghost path to it, where it can be found on screen.
                if !super::cursor_run::show_me(app, &text) {
                    coach::notify(app, &format!("Next step: {text}"));
                }
            } else {
                coach::notify(app, &format!("Next step: {text}"));
            }
        }
    }
}

/// Switches branch with git's own safe commands: stash first only if the receiver says so,
/// never discarding anything; a pull is fast-forward only.
fn switch_branch<R: Runtime>(app: &AppHandle<R>, repo: &str, branch: &str) {
    let repo_path = Path::new(repo);
    let run = |step: &GitStep| git::run(repo_path, &step.args(), Duration::from_secs(30));
    let Some(status) = run(&GitStep::Status) else {
        coach::notify(app, "Couldn't read that repository with git.");
        return;
    };
    if run(&GitStep::Current).is_some_and(|c| c.trim() == branch) {
        coach::notify(app, &format!("Already on {branch}."));
        return;
    }
    let has_changes = status.lines().any(|l| !l.trim().is_empty());
    let stash = if has_changes {
        let choice = chores::dialog(
            "You have uncommitted changes",
            &format!("Switch {repo} to {branch}? Your changes are kept either way."),
            None,
            &["Stash them first (git stash push), then switch".to_owned()],
            "Stash and switch",
        );
        if choice.is_none() {
            return;
        }
        true
    } else {
        if chores::dialog(
            &format!("Switch to {branch} and pull?"),
            repo,
            None,
            &[],
            "Switch",
        )
        .is_none()
        {
            return;
        }
        false
    };
    let Some(steps) = pickup::git_steps(branch, has_changes, stash) else {
        return;
    };
    for step in steps {
        if run(&step).is_none() {
            let what = match step {
                GitStep::StashPush => "stash your changes",
                GitStep::Switch(_) => "switch branch",
                _ => "pull (fast-forward only)",
            };
            coach::notify(
                app,
                &format!("git couldn't {what}; nothing else was changed."),
            );
            return;
        }
    }
    coach::notify(app, &format!("Switched to {branch}."));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_strict() {
        let ok = Url::parse("neb://handoff/0b0e7f6a-1c2d-4e5f-8a9b-0c1d2e3f4a5b").unwrap();
        assert_eq!(
            parse_link(&ok).as_deref(),
            Some("0b0e7f6a-1c2d-4e5f-8a9b-0c1d2e3f4a5b")
        );
        for bad in [
            "neb://handoff/../etc",
            "neb://handoff/0b0e7f6a-1c2d-4e5f-8a9b-0c1d2e3f4a5b?pick=1",
            "neb://sign-in/0b0e7f6a-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
            "https://handoff/0b0e7f6a-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
            "neb://handoff/not-a-uuid",
        ] {
            assert!(parse_link(&Url::parse(bad).unwrap()).is_none(), "{bad}");
        }
    }

    #[test]
    fn local_repos_are_found_by_folder_name_only() {
        assert!(local_repo("..\\windows").is_none());
        assert!(local_repo("C:\\x").is_none());
        assert!(local_repo("").is_none());
    }
}
