//! Native Spotify / Apple Music scripting dictionaries and exact foreground YouTube AX controls.
//! Idle setup never starts osascript. Only the local island's explicit panel/control intent
//! enables AppleEvents. Unknown or ambiguous browser/player evidence always refuses.
use super::overlay;
use crate::screen::{
    music::{Control, MusicView, NowPlaying},
    surfaces::Surface,
};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc::{self, SyncSender},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

#[path = "apple_art.rs"]
mod apple_art;
#[path = "browser_media.rs"]
mod browser;
#[path = "companion_media.rs"]
mod companion;

const SCRIPT: &str = include_str!("media.js");
const LIMIT: u64 = 8192;
const TIMEOUT: Duration = Duration::from_secs(3);
const REFRESH: Duration = Duration::from_secs(1);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Failure {
    Unavailable,
    Denied,
    Timeout,
    Cancelled,
    Ambiguous,
    Changed,
}
impl Failure {
    fn notice(self) -> &'static str {
        match self {
        Self::Denied => "Allow Neb to control your music player in System Settings → Privacy & Security → Automation.",
        Self::Timeout => "The music player took too long to respond.",
        Self::Ambiguous => "More than one player is available. Leave one playing to choose it.",
        Self::Changed => "The player or track changed. Try the control again.",
        _ => "Play media in Spotify, Music, TV, VLC, QuickTime, a permitted website in a paired browser, or a normal Chrome/Brave YouTube watch page.",
    }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Track {
    app: String,
    pid: i32,
    launch: String,
    track: String,
    title: String,
    artist: String,
    playing: bool,
    #[serde(skip)]
    browser: Option<browser::Identity>,
    #[serde(skip)]
    companion: Option<companion::Identity>,
    #[serde(skip)]
    art: Option<String>,
    #[serde(default)]
    artwork_url: Option<String>,
}
impl Track {
    fn view(&self) -> Option<NowPlaying> {
        if self.pid <= 0
            || !self
                .launch
                .parse::<f64>()
                .is_ok_and(|value| value.is_finite() && value > 0.)
            || self.launch.len() > 64
            || self.track.is_empty()
            || self.track.len() > 2048
        {
            return None;
        }
        let player = match self.app.as_str() {
            "com.spotify.client" => "Spotify",
            "com.apple.Music" => "Apple Music",
            "com.apple.TV" => "Apple TV",
            "org.videolan.vlc" if hashed_native_key(&self.track, "vlc:") => "VLC",
            "com.apple.QuickTimePlayerX" if hashed_native_key(&self.track, "quicktime:") => {
                "QuickTime Player"
            }
            _ if companion::accepts(self) => "Browser",
            "com.google.Chrome" if browser::accepts(self) => "Chrome",
            "com.brave.Browser" if browser::accepts(self) => "Brave",
            _ => return None,
        };
        let mut now = NowPlaying::new(&self.title, &self.artist, &self.app)?;
        now.player = Some(player);
        now.playing = self.playing;
        now.can_next = true;
        now.can_previous = true;
        if self.app == "com.apple.QuickTimePlayerX" {
            now.can_next = false;
            now.can_previous = false;
        }
        if let Some(browser) = &self.browser {
            now.can_next = browser.can_next;
            now.can_previous = browser.can_previous;
        }
        if let Some((next, previous)) = companion::capabilities(self) {
            now.can_next = next;
            now.can_previous = previous;
        }
        now.art = self.art.clone();
        Some(now)
    }
}
fn hashed_native_key(key: &str, prefix: &str) -> bool {
    key.strip_prefix(prefix).is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    now: Option<Track>,
    error: Option<String>,
}
fn parse(bytes: &[u8]) -> Result<Option<Track>, Failure> {
    if bytes.len() as u64 > LIMIT {
        return Err(Failure::Unavailable);
    }
    let reply: Reply = serde_json::from_slice(bytes).map_err(|_| Failure::Unavailable)?;
    if let Some(error) = reply.error {
        return Err(match error.as_str() {
            "denied" => Failure::Denied,
            "timeout" => Failure::Timeout,
            "ambiguous" => Failure::Ambiguous,
            "changed" => Failure::Changed,
            _ => Failure::Unavailable,
        });
    }
    if reply
        .now
        .as_ref()
        .is_some_and(|track| track.view().is_none())
    {
        return Err(Failure::Unavailable);
    }
    Ok(reply.now)
}
fn cached_art(
    previous: Option<&Track>,
    track: &Track,
    fetch: &dyn Fn() -> Option<String>,
) -> Option<String> {
    // Cache absence too, until the selected process or track changes.
    match previous.filter(|p| {
        p.app == track.app
            && p.pid == track.pid
            && p.launch == track.launch
            && p.track == track.track
    }) {
        Some(previous) => previous.art.clone(),
        None => fetch(),
    }
}
fn select(native: Option<Track>, browser: Option<Track>) -> Result<Option<Track>, Failure> {
    match (native, browser) {
        (Some(a), Some(b)) if a.playing != b.playing => Ok(Some(if a.playing { a } else { b })),
        (Some(_), Some(_)) => Err(Failure::Ambiguous),
        (a, b) => Ok(a.or(b)),
    }
}
fn read_arguments(previous: Option<&Track>) -> Vec<String> {
    let mut args = vec!["read".into()];
    if let Some(movie) =
        previous.filter(|track| track.app == "com.apple.QuickTimePlayerX" && track.view().is_some())
    {
        // This approval is native-owned panel memory, never a webview-supplied identity.
        if let Ok(identity) = serde_json::to_string(
            &serde_json::json!({"app":movie.app,"pid":movie.pid,"launch":movie.launch,"track":movie.track,"playing":movie.playing}),
        ) {
            args.push(identity);
        }
    }
    args
}
trait Runner: Send + 'static {
    fn run(&mut self, args: &[String], valid: &dyn Fn() -> bool) -> Result<Vec<u8>, Failure>;
}
struct Osascript;
impl Runner for Osascript {
    fn run(&mut self, args: &[String], valid: &dyn Fn() -> bool) -> Result<Vec<u8>, Failure> {
        if !valid() {
            return Err(Failure::Cancelled);
        }
        // Source is fixed. argv values are never reinterpreted as shell or JavaScript source.
        let mut command = Command::new("/usr/bin/osascript");
        command.args(["-l", "JavaScript", "-e", SCRIPT]).args(args);
        run_command(command, valid, TIMEOUT)
    }
}
fn run_command(
    mut command: Command,
    valid: &dyn Fn() -> bool,
    timeout: Duration,
) -> Result<Vec<u8>, Failure> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| Failure::Unavailable)?;
    let stdout = child.stdout.take().ok_or(Failure::Unavailable)?;
    // Read concurrently to avoid filling a pipe, retaining at most LIMIT+1 bytes.
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.take(LIMIT + 1).read_to_end(&mut bytes);
        bytes
    });
    let start = Instant::now();
    let status = loop {
        if !valid() {
            break Err(Failure::Cancelled);
        }
        if start.elapsed() >= timeout {
            break Err(Failure::Timeout);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err(Failure::Unavailable)
                }
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => break Err(Failure::Unavailable),
        }
    };
    // Always kill/reap on timeout/cancellation, including an outstanding TCC request.
    if status.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let bytes = reader.join().map_err(|_| Failure::Unavailable)?;
    status?;
    Ok(bytes)
}
struct Shared {
    open: AtomicBool,
    generation: AtomicU64,
    target: Mutex<Option<Track>>,
    last_failure: Mutex<Option<Failure>>,
}
impl Shared {
    // ResizeObserver also sends MusicPanel(open=true). Only an actual visibility edge
    // authorizes a new session; retaining generation also retains a worker's refusal.
    fn transition(&self, open: bool) -> Option<u64> {
        if self.open.swap(open, Ordering::AcqRel) == open {
            return None;
        }
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        *self.target.lock().unwrap_or_else(|p| p.into_inner()) = None;
        *self.last_failure.lock().unwrap_or_else(|p| p.into_inner()) = None;
        Some(generation)
    }
    // A pin/status refresh is not a successful media query. Keep the last refusal until
    // another actual query succeeds or a visibility edge resets the session.
    fn presentation(
        &self,
        query: Option<Result<Option<Track>, Failure>>,
    ) -> Result<Option<Track>, Failure> {
        if let Some(result) = query {
            if result != Err(Failure::Cancelled) {
                *self.last_failure.lock().unwrap_or_else(|p| p.into_inner()) =
                    result.as_ref().err().copied();
            }
            result
        } else if let Some(failure) = *self.last_failure.lock().unwrap_or_else(|p| p.into_inner()) {
            Err(failure)
        } else {
            Ok(self
                .target
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone())
        }
    }
    fn valid(&self, generation: u64) -> bool {
        self.open.load(Ordering::Acquire) && self.generation.load(Ordering::Acquire) == generation
    }
}
enum Work {
    Panel(u64),
    Control(u64, Box<Track>, Control),
}
pub struct Service {
    shared: Arc<Shared>,
    tx: SyncSender<Work>,
}
fn consent_flags(paused: bool, visible_overlays: bool) -> bool {
    !paused && visible_overlays
}
// Read the currently published configuration at every asynchronous boundary. The
// generation can remain valid briefly while runtime::update is applying revocation.
fn consent(app: &AppHandle) -> bool {
    super::runtime::of(app).is_ok_and(|runtime| {
        let (config, _) = runtime.snapshot();
        consent_flags(config.paused, config.privacy.show_in_captures)
    })
}
/// Registers an idle worker. Does not discover players or request permission.
pub fn setup(app: &AppHandle) -> Result<(), String> {
    if app.try_state::<Service>().is_some() {
        return Err("Music is already initialized.".into());
    }
    let shared = Arc::new(Shared {
        open: AtomicBool::new(false),
        generation: AtomicU64::new(0),
        target: Mutex::new(None),
        last_failure: Mutex::new(None),
    });
    let (tx, rx) = mpsc::sync_channel(8);
    let state = shared.clone();
    let worker_app = app.clone();
    std::thread::Builder::new()
        .name("neb-mac-music".into())
        .spawn(move || {
            let mut runner = Osascript;
            let mut failed_generation = None;
            loop {
                let work = match rx.recv_timeout(REFRESH) {
                    Ok(work) => Some(work),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                let generation = state.generation.load(Ordering::Acquire);
                if !state.valid(generation)
                    || !consent(&worker_app)
                    || (work.is_none() && failed_generation == Some(generation))
                {
                    continue;
                }
                let valid = || state.valid(generation) && consent(&worker_app);
                let result = match work {
                    Some(Work::Panel(token)) if token != generation => continue,
                    Some(Work::Control(token, target, control)) => {
                        if token != generation {
                            continue;
                        }
                        if target.companion.is_some() {
                            let control_state = state.clone();
                            let control_app = worker_app.clone();
                            let gate = Arc::new(move || control_state.valid(generation) && consent(&control_app));
                            companion::control(&worker_app, generation, &target, control, &valid, gate)
                        } else if target.browser.is_some() {
                            browser::query(&worker_app, generation, Some((*target, control)), None).map(|_| ())
                        } else {
                        let command = match control {
                            Control::PlayPause => "play_pause",
                            Control::Next => "next",
                            Control::Previous => "previous",
                        };
                        let expected = match serde_json::to_string(&serde_json::json!({"app": target.app, "pid":target.pid, "launch":target.launch, "track":target.track, "playing":target.playing})) {
                            Ok(value) => value,
                            Err(_) => continue,
                        };
                        runner
                            .run(&["control".into(), expected, command.into()], &valid)
                            .and_then(|bytes| parse(&bytes))
                            .map(|_| ())
                        }
                    }
                    _ => Ok(()),
                };
                let result = result.and_then(|_| {
                    let previous = state.target.lock().unwrap_or_else(|p|p.into_inner()).clone();
                    runner
                        .run(&read_arguments(previous.as_ref()), &valid)
                        .and_then(|bytes| parse(&bytes))
                        .and_then(|native| {
                            let retained = state.target.lock().unwrap_or_else(|p| p.into_inner()).clone().filter(|t| t.browser.is_some());
                            let prior_companion = previous.as_ref().filter(|t| t.companion.is_some());
                            let paired = companion::query(&worker_app, generation, prior_companion, &valid)?;
                            let legacy = browser::query(&worker_app, generation, None, retained)?;
                            let web = companion::prefer_inspected_player(paired, legacy)?;
                            select(native, web)
                        })
                });
                let result = result.map(|track| track.map(|mut track| {
                    if track.browser.is_some() || track.artwork_url.is_some() || matches!(track.app.as_str(), "com.apple.Music" | "com.apple.TV") {
                        let previous = state.target.lock().unwrap_or_else(|p| p.into_inner()).clone();
                        track.art = cached_art(previous.as_ref(), &track, &|| if matches!(track.app.as_str(), "com.apple.Music" | "com.apple.TV") { apple_art::read(&worker_app, generation, &track, &valid) } else { browser::artwork(&track, &valid) });
                    }
                    track
                }));
                if !valid() {
                    continue;
                }
                // Refusal/timeouts stop polling until a new explicit panel intent.
                failed_generation = result.as_ref().err().map(|_| generation);
                publish(&worker_app, state.clone(), generation, Some(result));
            }
        })
        .map_err(|_| "Couldn't start music controls.".to_owned())?;
    if !app.manage(Service { shared, tx }) {
        return Err("Music is already initialized.".into());
    }
    Ok(())
}
fn publish(
    app: &AppHandle,
    state: Arc<Shared>,
    generation: u64,
    query: Option<Result<Option<Track>, Failure>>,
) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if !state.valid(generation) || !consent(&app_handle) {
            return;
        }
        let (track, notice) = match state.presentation(query) {
            Ok(track) => (track, None),
            Err(Failure::Cancelled) => return,
            Err(error) => (None, Some(error.notice().to_owned())),
        };
        let pins = super::media_pins::snapshot(&app_handle);
        let (pin_notice, pinning) = super::media_pins::status(&app_handle);
        let view = MusicView::new(
            track.as_ref().and_then(Track::view),
            &pins,
            notice.or(pin_notice),
            pinning,
        );
        // Bind controls to the identity actually sent to the local page, not a later query.
        if overlay::dispatch(
            &app_handle,
            Surface::Island,
            "mew:island-music",
            &serde_json::to_value(view).unwrap_or_default(),
        )
        .is_ok()
        {
            *state.target.lock().unwrap_or_else(|p| p.into_inner()) = track;
        } else {
            *state.target.lock().unwrap_or_else(|p| p.into_inner()) = None;
        }
    });
}
fn service(app: &AppHandle) -> Result<tauri::State<'_, Service>, String> {
    app.try_state::<Service>()
        .ok_or_else(|| "Music controls are unavailable.".into())
}
/// Called only after the local island's explicit music-panel action.
pub fn panel(app: &AppHandle, open: bool) -> Result<(), String> {
    if open && !consent(app) {
        return Err("Music controls require unpaused visible Mac overlays.".into());
    }
    let state = service(app)?;
    let Some(generation) = state.shared.transition(open) else {
        return Ok(());
    };
    // Clear metadata immediately on open/close. Main-queue completion checks prevent an
    // older clear from overwriting a newer session after close/reopen.
    let shared = state.shared.clone();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if shared.generation.load(Ordering::Acquire) != generation {
            return;
        }
        let view = MusicView::new(None, &[], None, false);
        let _ = overlay::dispatch(
            &handle,
            Surface::Island,
            "mew:island-music",
            &serde_json::to_value(view).unwrap_or_default(),
        );
    });
    if open {
        state.tx.try_send(Work::Panel(generation)).map_err(|_| {
            state.shared.open.store(false, Ordering::Release);
            "Music controls are busy. Try again.".to_owned()
        })?;
    }
    Ok(())
}
/// Hiding/closing the island must call this before native hide. Clears cached identity.
pub fn close(app: &AppHandle) -> Result<(), String> {
    panel(app, false)
}
pub fn control(app: &AppHandle, control: Control) -> Result<(), String> {
    let state = service(app)?;
    let generation = state.shared.generation.load(Ordering::Acquire);
    if !state.shared.valid(generation) || !consent(app) {
        return Err("Open the music panel with unpaused visible Mac overlays first.".into());
    }
    let target = state
        .shared
        .target
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or("No single music player is selected.")?;
    state
        .tx
        .try_send(Work::Control(generation, Box::new(target), control))
        .map_err(|_| "Music controls are busy. Try again.".into())
}
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PlaybackSnapshot {
    pub playing: bool,
    pub position_sec: Option<u32>,
    pub source_url: String,
}
/// Read-only capture/source media metadata; caller supplies its exact-target authorization.
pub(crate) fn playback_for_target_main(
    expected: &super::pipeline::Target,
    generation: u64,
    deadline: Instant,
    current: &dyn Fn() -> bool,
) -> Option<PlaybackSnapshot> {
    browser::playback_for_target_main(expected, generation, deadline, current)
}
pub fn intent_generation(app: &AppHandle) -> Option<u64> {
    let state = service(app).ok()?;
    let token = state.shared.generation.load(Ordering::Acquire);
    (state.shared.valid(token) && consent(app)).then_some(token)
}
pub fn is_current(app: &AppHandle, token: u64) -> bool {
    consent(app) && service(app).is_ok_and(|s| s.shared.valid(token))
}
/// Republish pins/current metadata without sending another AppleEvent.
pub fn refresh(app: &AppHandle) {
    let Ok(state) = service(app) else {
        return;
    };
    let Some(generation) = intent_generation(app) else {
        return;
    };
    publish(app, state.shared.clone(), generation, None);
}
pub fn pin(app: &AppHandle) -> Result<(), String> {
    super::media_pins::pin(app)
}
pub fn open_pin(app: &AppHandle, id: &str) -> Result<(), String> {
    super::media_pins::open(app, id)
}
pub fn unpin(app: &AppHandle, id: &str) -> Result<(), String> {
    super::media_pins::unpin(app, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct FakeRunner(Result<Vec<u8>, Failure>);
    impl Runner for FakeRunner {
        fn run(&mut self, _: &[String], valid: &dyn Fn() -> bool) -> Result<Vec<u8>, Failure> {
            if !valid() {
                Err(Failure::Cancelled)
            } else {
                self.0.clone()
            }
        }
    }
    fn fixture() -> Track {
        Track {
            app: "com.apple.Music".into(),
            pid: 123,
            launch: "100.5".into(),
            track: "ABC123".into(),
            title: "Song\nTitle".into(),
            artist: "Artist".into(),
            playing: false,
            browser: None,
            companion: None,
            art: None,
            artwork_url: None,
        }
    }
    #[test]
    fn artwork_absence_is_cached_until_process_or_track_changes() {
        let track = fixture();
        let calls = std::cell::Cell::new(0);
        let fetch = || {
            calls.set(calls.get() + 1);
            None
        };
        assert_eq!(cached_art(None, &track, &fetch), None);
        for _ in 0..5 {
            assert_eq!(cached_art(Some(&track), &track, &fetch), None);
        }
        assert_eq!(calls.get(), 1);
        let mut newer = track.clone();
        newer.launch = "101.5".into();
        cached_art(Some(&track), &newer, &fetch);
        assert_eq!(calls.get(), 2);
    }
    #[test]
    fn combined_players_never_silently_choose_between_two_playing_or_paused_tracks() {
        let a = fixture();
        let mut b = fixture();
        b.pid += 1;
        assert_eq!(
            select(Some(a.clone()), Some(b.clone())),
            Err(Failure::Ambiguous)
        );
        b.playing = true;
        assert_eq!(
            select(Some(a.clone()), Some(b.clone())),
            Ok(Some(b.clone()))
        );
        let mut a = a;
        a.playing = true;
        assert_eq!(select(Some(a), Some(b)), Err(Failure::Ambiguous));
    }
    #[test]
    fn only_the_displayed_exact_quicktime_movie_receives_paused_playback_approval() {
        assert_eq!(read_arguments(None), vec!["read"]);
        let mut movie = fixture();
        assert_eq!(read_arguments(Some(&movie)), vec!["read"]);
        movie.app = "com.apple.QuickTimePlayerX".into();
        assert_eq!(read_arguments(Some(&movie)), vec!["read"]);
        movie.track = format!("quicktime:{}", "a".repeat(64));
        let args = read_arguments(Some(&movie));
        let expected: serde_json::Value = serde_json::from_str(&args[1]).unwrap();
        assert_eq!(expected["app"], movie.app);
        assert_eq!(expected["pid"], movie.pid);
        assert_eq!(expected["launch"], movie.launch);
        assert_eq!(expected["track"], movie.track);
        assert!(expected.get("title").is_none());
        assert!(expected.get("artist").is_none());
    }
    #[test]
    fn native_player_names_and_capabilities_require_real_adapter_identities() {
        let mut track = fixture();
        track.app = "com.apple.TV".into();
        assert_eq!(track.view().unwrap().player, Some("Apple TV"));
        track.app = "com.apple.QuickTimePlayerX".into();
        assert!(track.view().is_none());
        track.track = format!("quicktime:{}", "a".repeat(64));
        let now = track.view().unwrap();
        assert_eq!(now.player, Some("QuickTime Player"));
        assert!(!now.can_next && !now.can_previous);
        track.app = "org.videolan.vlc".into();
        assert!(track.view().is_none());
        track.track = format!("vlc:{}", "b".repeat(64));
        let now = track.view().unwrap();
        assert_eq!(now.player, Some("VLC"));
        assert!(now.can_next && now.can_previous);
        assert!(!hashed_native_key(
            "vlc:/Users/synthetic/private.mov",
            "vlc:"
        ));
    }
    #[test]
    fn parses_actual_state_and_names_apple_music() {
        let track = fixture();
        let reply = serde_json::json!({"now":track});
        let parsed = parse(&serde_json::to_vec(&reply).unwrap())
            .unwrap()
            .unwrap();
        let now = parsed.view().unwrap();
        assert!(!now.playing);
        assert_eq!(now.player, Some("Apple Music"));
        assert_eq!(now.title, "Song Title");
        assert!(now.art.is_none());
        assert!(parse(br#"{"now":null}"#).unwrap().is_none());
    }
    #[test]
    fn rejects_malformed_unsupported_and_oversized_replies() {
        assert_eq!(parse(b"not json"), Err(Failure::Unavailable));
        assert_eq!(
            parse(&vec![b' '; LIMIT as usize + 1]),
            Err(Failure::Unavailable)
        );
        for bad in ["org.browser", "com.spotify.client.evil"] {
            let mut track = fixture();
            track.app = bad.into();
            assert_eq!(
                parse(&serde_json::to_vec(&serde_json::json!({"now":track})).unwrap()),
                Err(Failure::Unavailable)
            );
        }
    }
    #[test]
    fn denial_timeout_and_cancellation_are_truthful() {
        assert_eq!(parse(br#"{"error":"denied"}"#), Err(Failure::Denied));
        assert_eq!(parse(br#"{"error":"ambiguous"}"#), Err(Failure::Ambiguous));
        let mut runner = FakeRunner(Err(Failure::Timeout));
        assert_eq!(runner.run(&[], &|| true), Err(Failure::Timeout));
        assert_eq!(runner.run(&[], &|| false), Err(Failure::Cancelled));
    }
    #[test]
    fn metadata_and_identity_never_become_executable_source() {
        let mut track = fixture();
        track.track = "\"; target.playpause(); //\n$(touch /tmp/x)".into();
        let argument = serde_json::to_string(&track).unwrap();
        let decoded: Track = serde_json::from_str(&argument).unwrap();
        assert_eq!(decoded, track);
        assert!(!SCRIPT.contains(&track.track));
        assert!(!SCRIPT.contains("eval("));
        assert!(SCRIPT.contains("Application(selected.pid)"));
        assert!(!SCRIPT.contains("Application(selected.app)"));
    }
    #[test]
    fn owned_synthetic_child_is_killed_and_reaped_on_timeout_or_cancel() {
        // /bin/sleep is owned by this test; no player, AppleEvents or permissions involved.
        let mut command = Command::new("/bin/sleep");
        command.arg("5");
        let start = Instant::now();
        assert_eq!(
            run_command(command, &|| true, Duration::from_millis(30)),
            Err(Failure::Timeout)
        );
        assert!(start.elapsed() < Duration::from_secs(2));
        let mut command = Command::new("/bin/sleep");
        command.arg("5");
        assert_eq!(
            run_command(command, &|| false, Duration::from_secs(1)),
            Err(Failure::Cancelled)
        );
    }
    #[test]
    fn panel_resizes_never_restart_refused_session_or_clear_target() {
        let state = Shared {
            open: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            target: Mutex::new(None),
            last_failure: Mutex::new(None),
        };
        assert_eq!(state.transition(false), None);
        let generation = state.transition(true).unwrap();
        *state.target.lock().unwrap() = Some(fixture());
        // The worker records refusal for this generation; resize notifications must not
        // produce another work item, clear the notice or invalidate the displayed target.
        let refused_generation = generation;
        for _ in 0..10 {
            assert_eq!(state.transition(true), None);
            assert_eq!(state.generation.load(Ordering::Acquire), refused_generation);
            assert_eq!(*state.target.lock().unwrap(), Some(fixture()));
        }
        assert_eq!(state.transition(false), Some(generation + 1));
        assert!(state.target.lock().unwrap().is_none());
        assert_eq!(state.transition(false), None);
        // Closing then reopening explicitly grants a fresh session and retry.
        assert_eq!(state.transition(true), Some(generation + 2));
        assert!(!state.valid(refused_generation));
    }
    #[test]
    fn live_consent_revocation_refuses_even_a_current_generation() {
        let state = Shared {
            open: AtomicBool::new(true),
            generation: AtomicU64::new(8),
            target: Mutex::new(Some(fixture())),
            last_failure: Mutex::new(None),
        };
        for (paused, visible, allowed) in [
            (false, true, true),
            (true, true, false),
            (false, false, false),
            (true, false, false),
        ] {
            // Simulate the interval after new config is published and before close has
            // invalidated this generation: token validity alone must never authorize work.
            assert!(state.valid(8));
            assert_eq!(state.valid(8) && consent_flags(paused, visible), allowed);
        }
    }
    #[test]
    fn pin_refresh_preserves_media_failure_until_query_success_or_reopen() {
        let state = Shared {
            open: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            target: Mutex::new(None),
            last_failure: Mutex::new(None),
        };
        state.transition(true).unwrap();
        for failure in [Failure::Denied, Failure::Timeout] {
            assert_eq!(state.presentation(Some(Err(failure))), Err(failure));
            // Even a stale previously displayed track cannot hide the refusal when pins
            // or their loading status change, and ResizeObserver does not reset it.
            *state.target.lock().unwrap() = Some(fixture());
            for _ in 0..3 {
                assert_eq!(state.transition(true), None);
                assert_eq!(state.presentation(None), Err(failure));
            }
            assert_eq!(
                state.presentation(Some(Err(Failure::Cancelled))),
                Err(Failure::Cancelled)
            );
            assert_eq!(state.presentation(None), Err(failure));
            assert_eq!(state.presentation(Some(Ok(None))), Ok(None));
            *state.target.lock().unwrap() = None;
            assert_eq!(state.presentation(None), Ok(None));
        }
        state.presentation(Some(Err(Failure::Denied))).unwrap_err();
        state.transition(false).unwrap();
        state.transition(true).unwrap();
        assert_eq!(state.presentation(None), Ok(None));
    }
    #[test]
    fn closing_invalidates_old_completions_and_controls() {
        let state = Shared {
            open: AtomicBool::new(true),
            generation: AtomicU64::new(4),
            target: Mutex::new(Some(fixture())),
            last_failure: Mutex::new(None),
        };
        assert!(state.valid(4));
        state.generation.fetch_add(1, Ordering::AcqRel);
        assert!(!state.valid(4));
        assert!(state.valid(5));
        state.open.store(false, Ordering::Release);
        assert!(!state.valid(5));
    }
}
