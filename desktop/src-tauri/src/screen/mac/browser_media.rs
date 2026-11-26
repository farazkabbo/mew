//! Explicit-panel, foreground YouTube controls through public AXPress only. No browser JS,
//! global media keys, app activation, or private MediaRemote API. A missing/localized AX
//! player contract is unavailable; a page title alone never authorizes a control.
use super::{Failure, Track};
use crate::screen::mac::{browser_mode, hand_policy_ax as ax, privacy, target};
use crate::screen::{
    base64,
    music::{self, Control},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    ffi::c_void,
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};
use tauri::AppHandle;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Identity {
    window: u32,
    bounds: [f64; 4],
    pub(super) can_next: bool,
    pub(super) can_previous: bool,
}
/// Only a canonical HTTPS watch page. Reject credentials, ports, ambiguous duplicate IDs,
/// arbitrary hosts/redirects, embeds and shorts, whose player contract differs.
fn video_id(raw: &str) -> Option<String> {
    let url = tauri::Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("www.youtube.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.path() != "/watch"
    {
        return None;
    }
    let ids: Vec<_> = url.query_pairs().filter(|(k, _)| k == "v").collect();
    let id = &ids.first()?.1;
    (ids.len() == 1
        && id.len() == 11
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'))
    .then(|| id.to_string())
}
pub(super) fn accepts(track: &Track) -> bool {
    track.browser.as_ref().is_some_and(|b| {
        b.window > 0
            && target::Rect::new(b.bounds[0], b.bounds[1], b.bounds[2], b.bounds[3]).is_some()
    }) && matches!(
        track.app.as_str(),
        "com.google.Chrome" | "com.brave.Browser"
    ) && video_id(&track.track).is_some()
}
fn playback(labels: &[String]) -> Option<bool> {
    let playing = labels.iter().filter(|s| s.as_str() == "Pause (k)").count();
    let paused = labels.iter().filter(|s| s.as_str() == "Play (k)").count();
    match (playing, paused) {
        (1, 0) => Some(true),
        (0, 1) => Some(false),
        _ => None,
    }
}
fn label(node: &ax::Owned, deadline: Instant) -> Option<String> {
    ax::attr(node.0, "AXTitle", deadline)
        .and_then(|v| ax::string(v.0))
        .filter(|v| !v.is_empty())
        .or_else(|| ax::attr(node.0, "AXDescription", deadline).and_then(|v| ax::string(v.0)))
}
fn descendants(root: &ax::Owned, deadline: Instant) -> Option<Vec<ax::Owned>> {
    let mut queue: VecDeque<_> = ax::children(root, 4097, deadline).into();
    let mut out = vec![];
    while let Some(node) = queue.pop_front() {
        if Instant::now() >= deadline || out.len() + queue.len() >= 4096 {
            return None;
        }
        let children = ax::children(&node, 4097, deadline);
        if children.len() > 4096 {
            return None;
        }
        queue.extend(children);
        out.push(node);
    }
    Some(out)
}
struct Snapshot {
    track: Track,
    button: Option<ax::Owned>,
}
fn snapshot(
    generation: u64,
    deadline: Instant,
    current: &dyn Fn() -> bool,
    action: Option<Control>,
) -> Option<Snapshot> {
    if !current() || !privacy::accessibility_trusted() {
        return None;
    }
    let process = privacy::frontmost_process_identity()?;
    if !matches!(
        process.bundle_id.as_str(),
        "com.google.Chrome" | "com.brave.Browser"
    ) {
        return None;
    }
    let window = target::frontmost_window_candidate(&target::AppIdentity {
        pid: process.pid,
        bundle_id: Some(process.bundle_id.clone()),
    })?;
    let native = ax::application(process.pid)?;
    let focused = ax::attr(native.0, "AXFocusedWindow", deadline)?;
    let position = ax::pair(ax::attr(focused.0, "AXPosition", deadline)?.0, 1)?;
    let size = ax::pair(ax::attr(focused.0, "AXSize", deadline)?.0, 2)?;
    if target::Rect::new(position.a, position.b, size.a, size.b) != Some(window.bounds)
        || target::visible_windows()?
            .iter()
            .filter(|w| w.pid == process.pid && w.layer == 0 && w.bounds == window.bounds)
            .count()
            != 1
    {
        return None;
    }
    let request = browser_mode::FocusRequest {
        pid: process.pid,
        bundle: process.bundle_id.clone(),
        launch: f64::from_bits(process.launch_time_bits).to_string(),
        cg_window_id: window.id,
        generation,
    };
    let live = || {
        current()
            && Instant::now() < deadline
            && privacy::frontmost_process_identity().as_ref() == Some(&process)
            && target::frontmost_window_candidate(&target::AppIdentity {
                pid: process.pid,
                bundle_id: Some(process.bundle_id.clone()),
            })
            .is_some_and(|w| w.id == window.id && w.bounds == window.bounds)
    };
    // Normal-mode proof is bound by unique native/script geometry, never equal numeric IDs.
    let (title, url) = browser_mode::saved_source(&request, window.bounds, &live)?;
    let id = video_id(&url)?;
    let nodes = descendants(&focused, deadline)?;
    let mut players = nodes
        .into_iter()
        .filter(|n| label(n, deadline).as_deref() == Some("YouTube Video Player"));
    let player = players.next()?;
    if players.next().is_some() {
        return None;
    }
    let nodes = descendants(&player, deadline)?;
    let mut buttons: Vec<(String, ax::Owned)> = nodes
        .into_iter()
        .filter_map(|n| {
            if !ax::element(n.0, process.pid)
                || ax::string(ax::attr(n.0, "AXRole", deadline)?.0)?.as_str() != "AXButton"
                || !ax::boolean(ax::attr(n.0, "AXEnabled", deadline)?.0)?
            {
                return None;
            }
            Some((label(&n, deadline)?, n))
        })
        .collect();
    let labels: Vec<_> = buttons.iter().map(|(name, _)| name.clone()).collect();
    let playing = playback(&labels)?;
    let one = |s: &str| labels.iter().filter(|l| l.as_str() == s).count() == 1;
    let can_next = one("Next (SHIFT+n)");
    let can_previous = one("Previous (SHIFT+p)");
    let wanted = match action {
        Some(Control::PlayPause) => Some(if playing { "Pause (k)" } else { "Play (k)" }),
        Some(Control::Next) if can_next => Some("Next (SHIFT+n)"),
        Some(Control::Previous) if can_previous => Some("Previous (SHIFT+p)"),
        Some(_) => return None,
        None => None,
    };
    let button = wanted
        .and_then(|name| buttons.iter().position(|(s, _)| s == name))
        .map(|i| buttons.swap_remove(i).1);
    // The active source is read a second time after all AX work; tab switches and SPA
    // navigation invalidate the transaction even when the window geometry stayed identical.
    let (_, after_url) = browser_mode::saved_source(&request, window.bounds, &live)?;
    let again = ax::attr(native.0, "AXFocusedWindow", deadline)?;
    if video_id(&after_url).as_deref() != Some(&id) || !ax::equal(&again, &focused) || !live() {
        return None;
    }
    let title = title
        .strip_suffix(" - YouTube")
        .unwrap_or(&title)
        .to_string();
    Some(Snapshot {
        track: Track {
            app: process.bundle_id,
            pid: process.pid,
            launch: request.launch,
            track: format!("https://www.youtube.com/watch?v={id}"),
            title,
            artist: String::new(),
            playing,
            art: None,
            artwork_url: None,
            browser: Some(Identity {
                window: window.id,
                bounds: [
                    window.bounds.x,
                    window.bounds.y,
                    window.bounds.width,
                    window.bounds.height,
                ],
                can_next,
                can_previous,
            }),
        },
        button,
    })
}
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementPerformAction(element: *const c_void, action: *const c_void) -> i32;
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
fn same_target(a: &Track, b: &Track) -> bool {
    a.app == b.app
        && a.pid == b.pid
        && a.launch == b.launch
        && a.track == b.track
        && a.playing == b.playing
        && a.browser == b.browser
}
/// Native AX references never cross threads. A timed-out queued action is revoked before it
/// can reach AXPress. The existing panel generation and consent gates are rechecked throughout.
pub(super) fn query(
    app: &AppHandle,
    generation: u64,
    expected: Option<(Track, Control)>,
) -> Result<Option<Track>, Failure> {
    let live = Arc::new(AtomicBool::new(true));
    let active = live.clone();
    let handle = app.clone();
    let deadline = Instant::now() + Duration::from_secs(3);
    let (tx, rx) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let current = || {
            active.load(Ordering::Acquire)
                && Instant::now() < deadline
                && super::is_current(&handle, generation)
        };
        if !current() {
            return;
        }
        let result = match expected {
            Some((expected, action)) => (|| {
                let first = snapshot(generation, deadline, &current, Some(action))
                    .ok_or(Failure::Changed)?;
                if !same_target(&first.track, &expected) {
                    return Err(Failure::Changed);
                }
                let fresh = snapshot(generation, deadline, &current, Some(action))
                    .ok_or(Failure::Changed)?;
                if !same_target(&fresh.track, &expected)
                    || !ax::equal(
                        first.button.as_ref().ok_or(Failure::Changed)?,
                        fresh.button.as_ref().ok_or(Failure::Changed)?,
                    )
                    || !current()
                {
                    return Err(Failure::Changed);
                }
                let button = fresh.button.ok_or(Failure::Changed)?;
                // Re-read play state on the exact retained button immediately before AXPress.
                let wanted = match action {
                    Control::PlayPause => {
                        if expected.playing {
                            "Pause (k)"
                        } else {
                            "Play (k)"
                        }
                    }
                    Control::Next => "Next (SHIFT+n)",
                    Control::Previous => "Previous (SHIFT+p)",
                };
                if label(&button, deadline).as_deref() != Some(wanted) || !current() {
                    return Err(Failure::Changed);
                }
                let press = ax::Owned::new(unsafe {
                    CFStringCreateWithBytes(std::ptr::null(), b"AXPress".as_ptr(), 7, 0x08000100, 0)
                })
                .ok_or(Failure::Unavailable)?;
                if unsafe { AXUIElementPerformAction(button.0, press.0) } != 0 {
                    return Err(Failure::Unavailable);
                }
                Ok(None)
            })(),
            None => Ok(snapshot(generation, deadline, &current, None).map(|s| s.track)),
        };
        if current() {
            let _ = tx.send(result);
        }
    })
    .map_err(|_| Failure::Unavailable)?;
    let result = rx
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| Failure::Timeout);
    live.store(false, Ordering::Release);
    result?
}
fn spotify_art_url(raw: &str) -> Option<String> {
    let url = tauri::Url::parse(raw).ok()?;
    let key = url.path().strip_prefix("/image/")?;
    (url.scheme() == "https"
        && url.host_str() == Some("i.scdn.co")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && key.len() == 40
        && key.bytes().all(|b| b.is_ascii_hexdigit()))
    .then(|| url.to_string())
}
/// Artwork URLs are constructed locally from a validated video ID, never from AX/page data.
/// No cookies, credentials, proxy or redirects; binary size and magic are both checked.
pub(super) fn artwork(track: &Track, current: &dyn Fn() -> bool) -> Option<String> {
    let url = if accepts(track) {
        format!(
            "https://i.ytimg.com/vi/{}/default.jpg",
            video_id(&track.track)?
        )
    } else if track.app == "com.spotify.client" {
        spotify_art_url(track.artwork_url.as_deref()?)?
    } else {
        return None;
    };
    if !current() {
        return None;
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?;
    let reply = client.get(url).send().ok()?;
    if reply.status() != reqwest::StatusCode::OK
        || reply
            .content_length()
            .is_some_and(|n| n > music::MAX_ART_BYTES as u64)
    {
        return None;
    }
    let mut bytes = vec![];
    reply
        .take(music::MAX_ART_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    let mime = music::art_mime(&bytes)?;
    current().then(|| format!("data:{mime};base64,{}", base64::encode(&bytes)))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn artwork_rejects_external_hosts_schemes_credentials_and_paths() {
        let id = "0123456789abcdef0123456789abcdef01234567";
        assert!(spotify_art_url(&format!("https://i.scdn.co/image/{id}")).is_some());
        for raw in [
            format!("http://i.scdn.co/image/{id}"),
            format!("https://i.scdn.co.evil/image/{id}"),
            format!("https://user@i.scdn.co/image/{id}"),
            format!("https://i.scdn.co/image/{id}?token=x"),
            format!("https://i.scdn.co/image/{id}/extra"),
            "data:image/jpeg;base64,abc".into(),
            "file:///tmp/art.jpg".into(),
        ] {
            assert!(spotify_art_url(&raw).is_none(), "{raw}");
        }
    }
    #[test]
    fn canonical_source_rejects_schemes_hosts_and_ambiguous_ids() {
        assert_eq!(
            video_id("https://www.youtube.com/watch?v=aZ09_-bcDEF&list=hello"),
            Some("aZ09_-bcDEF".into())
        );
        for url in [
            "javascript:alert(1)",
            "file:///watch?v=aZ09_-bcDEF",
            "https://www.youtube.com.evil/watch?v=aZ09_-bcDEF",
            "https://user@www.youtube.com/watch?v=aZ09_-bcDEF",
            "https://www.youtube.com/watch?v=aZ09_-bcDEF&v=aZ09_-bcDEF",
            "http://www.youtube.com/watch?v=aZ09_-bcDEF",
            "https://www.youtube.com/watch?v=../evil",
        ] {
            assert!(video_id(url).is_none(), "{url}");
        }
    }
    #[test]
    fn playback_never_guesses_from_title_or_duplicate_buttons() {
        let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(playback(&names(&["Pause (k)", "Mute (m)"])), Some(true));
        assert_eq!(playback(&names(&["Play (k)"])), Some(false));
        for v in [
            &["Pause"][..],
            &["Pause (k)", "Pause (k)"],
            &["Pause (k)", "Play (k)"],
            &[],
        ] {
            assert_eq!(playback(&names(v)), None);
        }
    }
    #[test]
    fn controls_bind_process_launch_window_source_and_play_state() {
        let t = Track {
            app: "com.google.Chrome".into(),
            pid: 12,
            launch: "123.5".into(),
            track: "https://www.youtube.com/watch?v=aZ09_-bcDEF".into(),
            title: "Title".into(),
            artist: String::new(),
            playing: true,
            art: None,
            artwork_url: None,
            browser: Some(Identity {
                window: 4,
                bounds: [0., 0., 800., 600.],
                can_next: false,
                can_previous: false,
            }),
        };
        assert!(accepts(&t));
        for mutate in [0, 1, 2, 3, 4] {
            let mut b = t.clone();
            match mutate {
                0 => b.pid += 1,
                1 => b.launch = "124.5".into(),
                2 => b.browser.as_mut().unwrap().window += 1,
                3 => b.track.push('x'),
                _ => b.playing = false,
            };
            assert!(!same_target(&t, &b));
        }
    }
}
