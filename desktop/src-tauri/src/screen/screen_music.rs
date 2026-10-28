//! The island's music panel on screen (`music.rs` has what it is). While the island shows, a
//! worker thread reads what's playing from Windows' media session every second and presses the
//! playback buttons; the island's page is sent the panel's view whenever it changes. When the
//! island hides, the worker ends and what was playing is forgotten.
//!
//! Pinning reads the clipboard once, for a Spotify link, and asks Spotify's public oEmbed
//! endpoint for the playlist's name (no account, no token, nothing of the student's but the link).

use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime, Url};

use super::base64;
use super::coach;
use super::music::{
    self, add_pin, oembed_title, parse_link, remove_pin, Control, MusicView, NowPlaying, Pin,
    MAX_CLIPBOARD_CHARS, MAX_PINS, NOTICE_CANT_OPEN, NOTICE_FULL, NOTICE_NO_LINK,
};
use super::overlay::{self, Surface};
use super::screen_island;
use super::win::media_session::{read_art, MediaSessions};
use super::win::{clipboard, http, system, ComThread};

const ISLAND_MUSIC: &str = "mew:island-music";
/// How often what's playing is read while the island shows.
const POLL_EVERY: Duration = Duration::from_secs(1);
const OEMBED: &str = "https://open.spotify.com/oembed";
/// oEmbed replies are a few hundred bytes; anything far bigger isn't one.
const MAX_OEMBED_BYTES: usize = 64 * 1024;

/// What the worker is asked to do (on its thread, which holds the media session).
enum Command {
    Control(Control),
    Pin,
}

#[derive(Default)]
struct Panel {
    pins: Vec<Pin>,
    /// What's playing: kept only while the island shows.
    now: Option<NowPlaying>,
    notice: Option<String>,
    pinning: bool,
}

pub struct Music {
    path: PathBuf,
    panel: Mutex<Panel>,
    /// The worker's queue while it runs.
    worker: Mutex<Option<Sender<Command>>>,
}

impl Music {
    fn panel(&self) -> MutexGuard<'_, Panel> {
        self.panel
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn worker(&self) -> MutexGuard<'_, Option<Sender<Command>>> {
        self.worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn save(&self, pins: &[Pin]) {
        if music::save(&self.path, pins).is_err() {
            eprintln!("[screen] couldn't save the island's pinned playlists");
        }
    }
}

/// Loads the pins (kept beside Screen Coach's settings) at start-up.
pub fn setup<R: Runtime>(app: &AppHandle<R>, config_dir: &std::path::Path) {
    let path = music::path_in(config_dir);
    let pins = music::load(&path);
    app.manage(Music {
        path,
        panel: Mutex::new(Panel {
            pins,
            ..Panel::default()
        }),
        worker: Mutex::new(None),
    });
}

/// The island showed: starts the worker (if it isn't running) and sends the panel's view.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let Some(music) = app.try_state::<Music>() else {
        return;
    };
    refresh(app);
    let mut worker = music.worker();
    if worker.is_some() {
        return;
    }
    let (sender, commands) = mpsc::channel();
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("mew-music".into())
        .spawn(move || run(&handle, &commands));
    if spawned.is_ok() {
        *worker = Some(sender);
    }
}

/// Sends the island's page the panel as it is now.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let Some(music) = app.try_state::<Music>() else {
        return;
    };
    let view = {
        let panel = music.panel();
        MusicView::new(
            panel.now.clone(),
            &panel.pins,
            panel.notice.clone(),
            panel.pinning,
        )
    };
    if let Ok(view) = serde_json::to_value(&view) {
        overlay::dispatch(app, Surface::Island, ISLAND_MUSIC, &view);
    }
}

/// A playback button on the panel.
pub fn control<R: Runtime>(app: &AppHandle<R>, control: Control) {
    send(app, Command::Control(control));
}

/// "Pin copied link": the worker reads the clipboard and looks the name up.
pub fn pin<R: Runtime>(app: &AppHandle<R>) {
    if let Some(music) = app.try_state::<Music>() {
        let mut panel = music.panel();
        if panel.pinning {
            return;
        }
        panel.pinning = true;
        panel.notice = None;
    }
    refresh(app);
    send(app, Command::Pin);
}

/// Opens a pin: in the Spotify app, or on Spotify's website without it.
pub fn open<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(music) = app.try_state::<Music>() else {
        return;
    };
    let Some(pin) = music.panel().pins.iter().find(|pin| pin.id == id).cloned() else {
        return;
    };
    let opened = system::open_spotify(&pin.app_uri())
        || Url::parse(&pin.web_url()).is_ok_and(|url| system::open_in_browser(&url));
    music.panel().notice = (!opened).then(|| NOTICE_CANT_OPEN.to_owned());
    refresh(app);
}

/// Unpins a pin.
pub fn unpin<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(music) = app.try_state::<Music>() else {
        return;
    };
    let pins = {
        let mut panel = music.panel();
        if !remove_pin(&mut panel.pins, id) {
            return;
        }
        panel.notice = None;
        panel.pins.clone()
    };
    music.save(&pins);
    refresh(app);
}

fn send<R: Runtime>(app: &AppHandle<R>, command: Command) {
    if let Some(music) = app.try_state::<Music>() {
        if let Some(worker) = music.worker().as_ref() {
            let _ = worker.send(command);
        }
    }
}

fn run<R: Runtime>(app: &AppHandle<R>, commands: &mpsc::Receiver<Command>) {
    let _com = ComThread::init();
    let sessions = MediaSessions::new();
    loop {
        match commands.recv_timeout(POLL_EVERY) {
            Ok(Command::Control(control)) => {
                if let Some(sessions) = &sessions {
                    sessions.control(control);
                }
            }
            Ok(Command::Pin) => pin_from_clipboard(app),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if !(screen_island::shown(app) && coach::is_usable(app)) {
            // Checked again under the worker's lock: an island shown again just now keeps it.
            let Some(music) = app.try_state::<Music>() else {
                break;
            };
            let mut worker = music.worker();
            if screen_island::shown(app) && coach::is_usable(app) {
                continue;
            }
            *worker = None;
            drop(worker);
            let mut panel = music.panel();
            panel.now = None;
            panel.notice = None;
            panel.pinning = false;
            break;
        }
        read_now_playing(app, sessions.as_ref());
    }
}

/// Reads what's playing; sends the panel only if it changed. Album art is read once per track.
fn read_now_playing<R: Runtime>(app: &AppHandle<R>, sessions: Option<&MediaSessions>) {
    let Some(music) = app.try_state::<Music>() else {
        return;
    };
    let track = sessions.and_then(MediaSessions::now_playing);
    let previous = music.panel().now.clone();
    let next = track.map(|track| {
        let mut now = track.now;
        now.art = match &previous {
            Some(previous) if previous.same_track(&now) => previous.art.clone(),
            _ => track
                .thumbnail
                .as_ref()
                .and_then(read_art)
                .map(|(bytes, mime)| {
                    let mut encoded = Vec::with_capacity(base64::encoded_len(bytes.len()));
                    base64::encode_into(&bytes, &mut encoded);
                    format!("data:{mime};base64,{}", String::from_utf8_lossy(&encoded))
                }),
        };
        now
    });
    if next == previous {
        return;
    }
    music.panel().now = next;
    refresh(app);
}

/// Pins the playlist or album whose link is on the clipboard, named as Spotify names it.
fn pin_from_clipboard<R: Runtime>(app: &AppHandle<R>) {
    let Some(music) = app.try_state::<Music>() else {
        return;
    };
    let link = clipboard::text(MAX_CLIPBOARD_CHARS + 1).and_then(|text| parse_link(&text));
    let Some((kind, id)) = link else {
        let mut panel = music.panel();
        panel.pinning = false;
        panel.notice = Some(NOTICE_NO_LINK.to_owned());
        drop(panel);
        refresh(app);
        return;
    };
    let mut pin = Pin {
        kind,
        id,
        name: Pin::fallback_name(kind),
    };
    if let Some(name) = look_up_name(&pin) {
        pin.name = name;
    }
    let pins = {
        let mut panel = music.panel();
        let full = panel.pins.len() >= MAX_PINS && !panel.pins.iter().any(|old| old.id == pin.id);
        add_pin(&mut panel.pins, pin);
        panel.pinning = false;
        panel.notice = full.then(|| NOTICE_FULL.to_owned());
        panel.pins.clone()
    };
    music.save(&pins);
    refresh(app);
}

/// Spotify's name for a pin, from its public oEmbed endpoint; None if it doesn't say.
fn look_up_name(pin: &Pin) -> Option<String> {
    let url = Url::parse_with_params(OEMBED, &[("url", pin.web_url())]).ok()?;
    let mut body = Vec::new();
    let status = http::get(&url, |chunk| {
        if body.len() < MAX_OEMBED_BYTES {
            body.extend_from_slice(chunk);
        }
    })
    .ok()?;
    (status == 200 && body.len() <= MAX_OEMBED_BYTES)
        .then(|| oembed_title(&body))
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::music::Kind;

    /// A real GET with no headers (it once crashed the app) and Spotify's name for a playlist.
    #[test]
    #[ignore = "needs the network"]
    fn looks_up_a_playlist_name() {
        let pin = Pin {
            kind: Kind::Playlist,
            id: "37i9dQZF1DXcBWIGoYBM5M".to_owned(),
            name: String::new(),
        };
        eprintln!("name: {:?}", look_up_name(&pin));
    }
}
