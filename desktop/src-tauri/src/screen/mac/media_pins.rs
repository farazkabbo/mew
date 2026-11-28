//! Explicit, local Spotify pins. Only canonical playlist/album identifiers leave the clipboard
//! boundary. One bounded worker resolves public names; final mutations run on the main queue.
use super::media;
use crate::screen::{
    music::{
        self, Pin, MAX_CLIPBOARD_CHARS, MAX_PINS, NOTICE_CANT_OPEN, NOTICE_FULL, NOTICE_NO_LINK,
    },
    secret::SecretBytes,
};
use objc2::MainThreadMarker;
use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString, NSWorkspace};
use objc2_foundation::{NSString, NSURL};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

const LIMIT: u64 = 64 * 1024;
const BUSY: &str = "Pinning is busy. Try again.";
const SAVE_FAILED: &str = "Couldn't save your Spotify pins.";

struct Panel {
    pins: Vec<Pin>,
    notice: Option<(u64, &'static str)>,
}
struct Shared {
    panel: Mutex<Panel>,
    busy: AtomicBool,
    last_pin: Mutex<Option<Instant>>,
    pinning_generation: Mutex<Option<u64>>,
    path: PathBuf,
}
struct Work {
    generation: u64,
    pin: Pin,
}
pub struct Service {
    shared: Arc<Shared>,
    tx: SyncSender<Work>,
}

fn load_bounded(path: &Path) -> Vec<Pin> {
    let Ok(file) = File::open(path) else {
        return vec![];
    };
    let mut bytes = Vec::new();
    if file.take(LIMIT + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > LIMIT {
        return vec![];
    }
    std::str::from_utf8(&bytes)
        .map(music::parse_pins)
        .unwrap_or_default()
}
fn service(app: &AppHandle) -> Result<tauri::State<'_, Service>, String> {
    app.try_state::<Service>()
        .ok_or_else(|| "Spotify pins are unavailable.".into())
}
/// Loading local pins does not read the clipboard or make a network request.
pub fn setup(app: &AppHandle) -> Result<(), String> {
    if app.try_state::<Service>().is_some() {
        return Err("Spotify pins are already initialized.".into());
    }
    let dir = app.path().app_config_dir().map_err(|_| SAVE_FAILED)?;
    let path = music::path_in(&dir);
    let shared = Arc::new(Shared {
        panel: Mutex::new(Panel {
            pins: load_bounded(&path),
            notice: None,
        }),
        busy: AtomicBool::new(false),
        last_pin: Mutex::new(None),
        pinning_generation: Mutex::new(None),
        path,
    });
    let (tx, rx) = mpsc::sync_channel::<Work>(1);
    let handle = app.clone();
    let worker = shared.clone();
    std::thread::Builder::new()
        .name("neb-mac-pins".into())
        .spawn(move || {
            while let Ok(work) = rx.recv() {
                let Some(pin) = fetch_pin(
                    work.pin,
                    &|| media::is_current(&handle, work.generation),
                    &resolve_name,
                ) else {
                    finish(&worker);
                    continue;
                };
                let complete = worker.clone();
                let publish = handle.clone();
                if handle
                    .run_on_main_thread(move || {
                        if media::is_current(&publish, work.generation) {
                            let mut panel =
                                complete.panel.lock().unwrap_or_else(|p| p.into_inner());
                            match commit_pin(&complete.path, &mut panel.pins, pin, &|| {
                                media::is_current(&publish, work.generation)
                            }) {
                                Ok(notice) => {
                                    panel.notice = notice.map(|notice| (work.generation, notice))
                                }
                                Err(CommitFailure::Save) => {
                                    panel.notice = Some((work.generation, SAVE_FAILED))
                                }
                                Err(CommitFailure::Cancelled) => {}
                            }
                        }
                        finish(&complete);
                        if media::is_current(&publish, work.generation) {
                            media::refresh(&publish);
                        }
                    })
                    .is_err()
                {
                    finish(&worker);
                }
            }
        })
        .map_err(|_| "Couldn't start Spotify pins.")?;
    if !app.manage(Service { shared, tx }) {
        return Err("Spotify pins are already initialized.".into());
    }
    Ok(())
}
fn finish(shared: &Shared) {
    *shared
        .pinning_generation
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = None;
    shared.busy.store(false, Ordering::Release);
}
pub fn snapshot(app: &AppHandle) -> Vec<Pin> {
    service(app)
        .map(|s| {
            s.shared
                .panel
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .pins
                .clone()
        })
        .unwrap_or_default()
}
/// Notices are scoped to the current panel session, never replayed after close/reopen.
pub fn status(app: &AppHandle) -> (Option<String>, bool) {
    let Ok(state) = service(app) else {
        return (None, false);
    };
    let notice = state
        .shared
        .panel
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .notice
        .and_then(|(token, message)| media::is_current(app, token).then(|| message.to_owned()));
    let pinning = state
        .shared
        .pinning_generation
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .is_some_and(|token| media::is_current(app, token));
    (notice, pinning)
}
fn canonical_clipboard(_main: MainThreadMarker) -> Option<Pin> {
    let clipboard = NSPasteboard::generalPasteboard();
    // Bound UTF-16 length before allocating a Rust copy. The NSString is never sent anywhere.
    let text = clipboard.stringForType(unsafe { NSPasteboardTypeString })?;
    if text.length() > MAX_CLIPBOARD_CHARS {
        return None;
    }
    let secret = SecretBytes::from_vec(text.to_string().into_bytes());
    let (kind, id) = music::parse_link(std::str::from_utf8(secret.as_slice()).ok()?)?;
    // SecretBytes wipes the owned allocation immediately after extracting only kind/id.
    Some(Pin {
        kind,
        id,
        name: Pin::fallback_name(kind),
    })
}
pub fn pin(app: &AppHandle) -> Result<(), String> {
    let generation = media::intent_generation(app).ok_or("Open the music panel first.")?;
    let state = service(app)?;
    let mut last = state
        .shared
        .last_pin
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if last.is_some_and(|time| time.elapsed() < Duration::from_secs(1)) {
        return Err(BUSY.into());
    }
    if state.shared.busy.swap(true, Ordering::AcqRel) {
        return Err(BUSY.into());
    }
    *last = Some(Instant::now());
    drop(last);
    *state
        .shared
        .pinning_generation
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some(generation);
    let shared = state.shared.clone();
    let tx = state.tx.clone();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if !media::is_current(&handle, generation) {
            finish(&shared);
            return;
        }
        let parsed = MainThreadMarker::new().and_then(canonical_clipboard);
        match parsed {
            Some(pin) => {
                shared
                    .panel
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .notice = None;
                if tx.try_send(Work { generation, pin }).is_err() {
                    finish(&shared);
                    shared
                        .panel
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .notice = Some((generation, BUSY));
                }
            }
            None => {
                finish(&shared);
                shared
                    .panel
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .notice = Some((generation, NOTICE_NO_LINK));
            }
        }
        media::refresh(&handle);
    })
    .map_err(|_| {
        finish(&state.shared);
        "Couldn't read the copied Spotify link.".to_owned()
    })
}
// The injected fetch seam keeps cancellation/fallback tests off the network.
fn fetch_pin(
    mut pin: Pin,
    current: &dyn Fn() -> bool,
    fetch: &dyn Fn(&Pin) -> Option<String>,
) -> Option<Pin> {
    if !current() {
        return None;
    }
    if let Some(name) = fetch(&pin) {
        pin.name = name;
    }
    current().then_some(pin)
}
fn resolve_name(pin: &Pin) -> Option<String> {
    static CLIENT: OnceLock<Option<reqwest::blocking::Client>> = OnceLock::new();
    let client = CLIENT
        .get_or_init(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
            reqwest::blocking::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(5))
                .build()
                .ok()
        })
        .as_ref()?;
    // Only canonical URLs derived from validated kind/id. No cookies, auth or clipboard query.
    let url =
        tauri::Url::parse_with_params("https://open.spotify.com/oembed", &[("url", pin.web_url())])
            .ok()?;
    let response = client.get(url).send().ok()?;
    if response.status() != reqwest::StatusCode::OK
        || response.content_length().is_some_and(|n| n > LIMIT)
    {
        return None;
    }
    let mut body = Vec::new();
    response.take(LIMIT + 1).read_to_end(&mut body).ok()?;
    if body.len() as u64 > LIMIT {
        return None;
    }
    music::oembed_title(&body)
}
#[derive(Debug, PartialEq)]
enum CommitFailure {
    Cancelled,
    Save,
}
fn commit_pin(
    path: &Path,
    pins: &mut Vec<Pin>,
    pin: Pin,
    current: &dyn Fn() -> bool,
) -> Result<Option<&'static str>, CommitFailure> {
    if !current() {
        return Err(CommitFailure::Cancelled);
    }
    let full = pins.len() >= MAX_PINS
        && !pins
            .iter()
            .any(|old| old.id == pin.id && old.kind == pin.kind);
    let mut next = pins.clone();
    music::add_pin(&mut next, pin);
    if !current() {
        return Err(CommitFailure::Cancelled);
    }
    music::save(path, &next).map_err(|_| CommitFailure::Save)?;
    *pins = next;
    Ok(full.then_some(NOTICE_FULL))
}
fn find_pin(pins: &[Pin], id: &str) -> Option<Pin> {
    pins.iter().find(|pin| pin.id == id).cloned()
}
fn open_with(pin: &Pin, has_handler: &dyn Fn(&str) -> bool, open: &dyn Fn(&str) -> bool) -> bool {
    let uri = pin.app_uri();
    (has_handler(&uri) && open(&uri)) || open(&pin.web_url())
}
pub fn open(app: &AppHandle, id: &str) -> Result<(), String> {
    let generation = media::intent_generation(app).ok_or("Open the music panel first.")?;
    let state = service(app)?;
    let pin = find_pin(
        &state
            .shared
            .panel
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pins,
        id,
    )
    .ok_or("That Spotify pin is unavailable.")?;
    let shared = state.shared.clone();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if !media::is_current(&handle, generation) {
            return;
        }
        let workspace = NSWorkspace::sharedWorkspace();
        let opened = open_with(
            &pin,
            &|uri| {
                NSURL::URLWithString(&NSString::from_str(uri))
                    .is_some_and(|url| workspace.URLForApplicationToOpenURL(&url).is_some())
            },
            &|uri| {
                NSURL::URLWithString(&NSString::from_str(uri))
                    .is_some_and(|url| workspace.openURL(&url))
            },
        );
        shared
            .panel
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .notice = (!opened).then_some((generation, NOTICE_CANT_OPEN));
        media::refresh(&handle);
    })
    .map_err(|_| NOTICE_CANT_OPEN.to_owned())
}
pub fn unpin(app: &AppHandle, id: &str) -> Result<(), String> {
    let generation = media::intent_generation(app).ok_or("Open the music panel first.")?;
    let state = service(app)?;
    if find_pin(
        &state
            .shared
            .panel
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pins,
        id,
    )
    .is_none()
    {
        return Err("That Spotify pin is unavailable.".into());
    }
    let id = id.to_owned();
    let shared = state.shared.clone();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if !media::is_current(&handle, generation) {
            return;
        }
        let mut panel = shared.panel.lock().unwrap_or_else(|p| p.into_inner());
        let mut next = panel.pins.clone();
        if music::remove_pin(&mut next, &id) {
            if music::save(&shared.path, &next).is_ok() {
                panel.pins = next;
                panel.notice = None;
            } else {
                panel.notice = Some((generation, SAVE_FAILED));
            }
        }
        drop(panel);
        media::refresh(&handle);
    })
    .map_err(|_| SAVE_FAILED.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::music::Kind;
    fn pin(n: usize) -> Pin {
        Pin {
            kind: Kind::Playlist,
            id: format!("{n:022}"),
            name: Pin::fallback_name(Kind::Playlist),
        }
    }
    fn path(label: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("neb-mac-pin-{}-{label}", std::process::id()))
            .join("music.json")
    }
    #[test]
    fn fake_fetch_checks_cancellation_and_keeps_truthful_fallback() {
        let called = std::cell::Cell::new(false);
        assert!(fetch_pin(pin(1), &|| false, &|_| {
            called.set(true);
            None
        })
        .is_none());
        assert!(!called.get());
        assert_eq!(fetch_pin(pin(1), &|| true, &|_| None), Some(pin(1)));
        let current = std::cell::Cell::new(true);
        assert!(fetch_pin(pin(1), &|| current.get(), &|_| {
            current.set(false);
            Some("Late title".into())
        })
        .is_none());
        assert_eq!(
            fetch_pin(pin(1), &|| true, &|_| Some("Public title".into()))
                .unwrap()
                .name,
            "Public title"
        );
    }
    #[test]
    fn fake_native_opener_uses_only_saved_canonical_targets() {
        let opened = std::cell::RefCell::new(vec![]);
        assert!(open_with(&pin(1), &|_| false, &|uri| {
            opened.borrow_mut().push(uri.to_owned());
            true
        }));
        assert_eq!(*opened.borrow(), vec![pin(1).web_url()]);
        opened.borrow_mut().clear();
        assert!(open_with(&pin(1), &|_| true, &|uri| {
            opened.borrow_mut().push(uri.to_owned());
            true
        }));
        assert_eq!(*opened.borrow(), vec![pin(1).app_uri()]);
    }
    #[test]
    fn persistence_dedup_limit_and_drop_notice() {
        let path = path("roundtrip");
        let mut pins = vec![];
        for n in 0..MAX_PINS {
            assert_eq!(commit_pin(&path, &mut pins, pin(n), &|| true), Ok(None));
        }
        assert_eq!(commit_pin(&path, &mut pins, pin(1), &|| true), Ok(None));
        assert_eq!(pins[0], pin(1));
        assert_eq!(
            commit_pin(&path, &mut pins, pin(6), &|| true),
            Ok(Some(NOTICE_FULL))
        );
        assert_eq!(pins.len(), 6);
        assert_eq!(load_bounded(&path), pins);
        music::remove_pin(&mut pins, &pin(1).id);
        music::save(&path, &pins).unwrap();
        assert_eq!(load_bounded(&path), pins);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
    #[test]
    fn cancelled_completion_never_persists_or_changes_pins() {
        let path = path("cancel");
        let mut pins = vec![pin(1)];
        assert_eq!(
            commit_pin(&path, &mut pins, pin(2), &|| false),
            Err(CommitFailure::Cancelled)
        );
        assert_eq!(pins, vec![pin(1)]);
        assert!(!path.exists());
        // Cancellation between fetch and commit is checked again before the atomic save.
        let calls = std::cell::Cell::new(0);
        assert_eq!(
            commit_pin(&path, &mut pins, pin(2), &|| {
                calls.set(calls.get() + 1);
                calls.get() == 1
            }),
            Err(CommitFailure::Cancelled)
        );
        assert!(!path.exists());
    }
    #[test]
    fn invalid_open_targets_and_untrusted_files_are_refused() {
        for target in [
            "spotify:playlist:0000000000000000000001",
            "https://evil.test",
            "../../x",
            "",
        ] {
            assert!(find_pin(&[pin(1)], target).is_none());
        }
        let path = path("bounded");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, vec![b' '; LIMIT as usize + 1]).unwrap();
        assert!(load_bounded(&path).is_empty());
        std::fs::write(
            &path,
            r#"{"pins":[{"kind":"playlist","id":"../../x","name":"bad"}]}"#,
        )
        .unwrap();
        assert!(load_bounded(&path).is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
