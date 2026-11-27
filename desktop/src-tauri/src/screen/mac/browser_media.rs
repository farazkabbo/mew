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
    position_sec: Option<u32>,
}
fn retained_process_matches(previous: &Track, process: &privacy::ProcessIdentity) -> bool {
    accepts(previous)
        && process.pid == previous.pid
        && process.bundle_id == previous.app
        && f64::from_bits(process.launch_time_bits).to_string() == previous.launch
}
fn snapshot(
    generation: u64,
    deadline: Instant,
    current: &dyn Fn() -> bool,
    action: Option<Control>,
    retained: Option<&Track>,
) -> Option<Snapshot> {
    if !current() || !privacy::accessibility_trusted() {
        return None;
    }
    let process = match retained {
        Some(previous) if accepts(previous) => privacy::process_identity(previous.pid)
            .filter(|p| retained_process_matches(previous, p))?,
        Some(_) => return None,
        None => privacy::frontmost_process_identity()?,
    };
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
    if let Some(previous) = retained {
        let expected = previous.browser.as_ref()?;
        if expected.window != window.id
            || expected.bounds
                != [
                    window.bounds.x,
                    window.bounds.y,
                    window.bounds.width,
                    window.bounds.height,
                ]
        {
            return None;
        }
    }
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
            && (if retained.is_some() {
                privacy::process_identity(process.pid)
            } else {
                privacy::frontmost_process_identity()
            })
            .as_ref()
                == Some(&process)
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
    let sliders: Vec<_> = nodes
        .iter()
        .filter(|n| {
            label(n, deadline).as_deref() == Some("Seek slider")
                && ax::attr(n.0, "AXRole", deadline)
                    .and_then(|v| ax::string(v.0))
                    .as_deref()
                    == Some("AXSlider")
        })
        .collect();
    let position_sec = if sliders.len() == 1 {
        let number = |name| ax::attr(sliders[0].0, name, deadline).and_then(|v| numeric(v.0));
        slider_seconds(
            number("AXValue"),
            number("AXMinValue"),
            number("AXMaxValue"),
        )
    } else {
        None
    };
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
    let source = format!("https://www.youtube.com/watch?v={id}");
    if retained.is_some_and(|previous| previous.track != source) {
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
            track: source,
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
        position_sec,
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
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFGetTypeID(value: *const c_void) -> usize;
    fn CFNumberGetTypeID() -> usize;
    fn CFNumberGetValue(value: *const c_void, kind: isize, out: *mut c_void) -> bool;
}
fn numeric(value: *const c_void) -> Option<f64> {
    let mut out = 0f64;
    (unsafe {
        CFGetTypeID(value) == CFNumberGetTypeID()
            && CFNumberGetValue(value, 6, (&mut out as *mut f64).cast())
    } && out.is_finite())
    .then_some(out)
}
fn slider_seconds(value: Option<f64>, min: Option<f64>, max: Option<f64>) -> Option<u32> {
    let (value, min, max) = (value?, min?, max?);
    (value.is_finite()
        && min == 0.
        && max.is_finite()
        && max > 0.
        && max <= 86400.
        && value >= min
        && value <= max)
        .then(|| value.floor() as u32)
}
/// Source/capture callers supply their own current-target authorization, independently of
/// the music panel. No AX action, permission prompt or pixel read occurs here.
pub(super) fn playback_for_target_main(
    expected: &crate::screen::mac::pipeline::Target,
    generation: u64,
    deadline: Instant,
    current: &dyn Fn() -> bool,
) -> Option<super::PlaybackSnapshot> {
    let sample = snapshot(generation, deadline, current, None, None)?;
    let browser = sample.track.browser.as_ref()?;
    (sample.track.pid == expected.process.pid
        && sample.track.app == expected.process.bundle_id
        && sample.track.launch == f64::from_bits(expected.process.launch_time_bits).to_string()
        && browser.window == expected.window_id
        && browser.bounds
            == [
                expected.quartz_points.x,
                expected.quartz_points.y,
                expected.quartz_points.width,
                expected.quartz_points.height,
            ]
        && current())
    .then_some(super::PlaybackSnapshot {
        playing: sample.track.playing,
        position_sec: sample.position_sec,
        source_url: sample.track.track,
    })
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
    retained: Option<Track>,
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
                let first = snapshot(
                    generation,
                    deadline,
                    &current,
                    Some(action),
                    Some(&expected),
                )
                .ok_or(Failure::Changed)?;
                if !same_target(&first.track, &expected) {
                    return Err(Failure::Changed);
                }
                let fresh = snapshot(
                    generation,
                    deadline,
                    &current,
                    Some(action),
                    Some(&expected),
                )
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
            None => Ok(snapshot(generation, deadline, &current, None, None)
                .or_else(|| {
                    retained.as_ref().and_then(|previous| {
                        snapshot(generation, deadline, &current, None, Some(previous))
                    })
                })
                .map(|s| s.track)),
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
    fn seek_slider_requires_numeric_seconds_and_complete_bounded_range() {
        assert_eq!(
            slider_seconds(Some(754.9), Some(0.), Some(1200.)),
            Some(754)
        );
        for (value, min, max) in [
            (Some(-1.), Some(0.), Some(1200.)),
            (Some(f64::NAN), Some(0.), Some(1200.)),
            (Some(754.), None, Some(1200.)),
            (Some(754.), Some(0.), None),
            (Some(754.), Some(1.), Some(1200.)),
            (Some(754.), Some(0.), Some(100.)),
            (Some(754.), Some(0.), Some(86401.)),
        ] {
            assert_eq!(slider_seconds(value, min, max), None);
        }
    }
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
        let process = privacy::ProcessIdentity {
            pid: t.pid,
            bundle_id: t.app.clone(),
            launch_time_bits: 123.5f64.to_bits(),
        };
        assert!(retained_process_matches(&t, &process));
        let mut reused = process.clone();
        reused.launch_time_bits = 124.5f64.to_bits();
        assert!(!retained_process_matches(&t, &reused));
        let mut replaced = process;
        replaced.bundle_id = "com.google.Chrome.evil".into();
        assert!(!retained_process_matches(&t, &replaced));
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
