//! Media-panel-only browser authority. Established by an explicit panel intent, never supplied
//! by a webview. Background controls retain the exact paired connection/window/document/player.
use super::{Failure, Track};
use crate::screen::{
    mac::{
        browser_bridge::{self, Bridge},
        capture_session,
        pipeline::Target,
        privacy, target,
    },
    music::Control,
    source,
};
use crate::{browser_companion_protocol as wire, browser_companion_server as broker};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Identity {
    target: Target,
    connection: String,
    window: wire::Window,
    media: wire::Media,
}
pub(super) fn accepts(track: &Track) -> bool {
    track.companion.as_ref().is_some_and(|b| {
        b.target.process.pid == track.pid
            && b.target.process.bundle_id == track.app
            && b.media.id == track.track
            && (f64::from_bits(b.target.process.launch_time_bits) + 978307200.).to_string()
                == track.launch
            && b.media.playing == track.playing
            && b.media.title == track.title
            && b.media.artist == track.artist
    })
}
fn native_current(
    app: &AppHandle,
    expected: &Target,
    frontmost: bool,
    browser: Option<wire::Window>,
) -> bool {
    let expected = expected.clone();
    let (tx, rx) = mpsc::sync_channel(1);
    let deadline = Instant::now() + Duration::from_millis(450);
    if app
        .run_on_main_thread(move || {
            let valid = privacy::accessibility_trusted()
                && privacy::process_identity(expected.process.pid).as_ref()
                    == Some(&expected.process)
                && (!frontmost
                    || privacy::frontmost_process_identity().as_ref() == Some(&expected.process))
                && target::visible_windows().is_some_and(|windows| {
                    if let Some(window) = browser.as_ref() {
                        return browser_bridge::unique_mapping(window, &expected, &windows);
                    }

                    let mut matches = windows.iter().filter(|w| {
                        w.pid == expected.process.pid
                            && w.layer == 0
                            && w.bounds == expected.quartz_points
                    });
                    matches.next().is_some_and(|w| w.id == expected.window_id)
                        && matches.next().is_none()
                })
                && capture_session::binding::focused_window_matches(
                    expected.process.pid,
                    expected.quartz_points,
                )
                && Instant::now() < deadline;
            let _ = tx.send(valid);
        })
        .is_err()
    {
        return false;
    }
    rx.recv_timeout(Duration::from_millis(450)).unwrap_or(false)
}
fn scope(window: &wire::Window) -> broker::Target {
    broker::Target {
        window_id: Some(window.id),
        tab_id: Some(window.tab.id),
        document_id: Some(window.tab.document_id.clone()),
        ..Default::default()
    }
}
fn matches_bounds(window: &wire::Window, target: &Target) -> bool {
    let b = target.quartz_points;
    [
        window.left - b.x,
        window.top - b.y,
        window.width - b.width,
        window.height - b.height,
    ]
    .iter()
    .all(|v| v.is_finite() && v.abs() <= 1.)
}
fn read(
    app: &AppHandle,
    generation: u64,
    prior: Option<&Track>,
    valid: &dyn Fn() -> bool,
) -> Result<Option<Track>, Failure> {
    if !valid() {
        return Err(Failure::Cancelled);
    }
    let Some(bridge) = app.try_state::<Bridge>() else {
        return Ok(None);
    };
    let retained = prior.and_then(|t| t.companion.as_ref());
    let (target, connection, probe_scope) = if let Some(binding) = retained {
        (
            binding.target.clone(),
            binding.connection.clone(),
            scope(&binding.window),
        )
    } else {
        let Some(target) = browser_bridge::focused_target(app) else {
            return Ok(None);
        };
        let candidates: Vec<_> = bridge
            .server
            .status()
            .into_iter()
            .filter(|c| {
                c.trusted
                    && c.browser_pid == target.process.pid
                    && c.browser_identifier == target.process.bundle_id
            })
            .collect();
        let [candidate] = candidates.as_slice() else {
            return Ok(None);
        };
        (
            target,
            candidate.connection_id.clone(),
            broker::Target::default(),
        )
    };
    if !native_current(app, &target, retained.is_none(), None) || !valid() {
        return Err(Failure::Changed);
    }
    let proof = bridge
        .server
        .request(&connection, generation, wire::Operation::Probe, probe_scope)
        .map_err(|_| Failure::Unavailable)?;
    if proof.status != wire::Status::Ok {
        return if retained.is_some() {
            Err(Failure::Changed)
        } else {
            Ok(None)
        };
    }
    let window = proof.window.ok_or(Failure::Unavailable)?;
    if window.incognito
        || !matches_bounds(&window, &target)
        || source::sanitize_url(&window.tab.url).is_none()
    {
        return Err(Failure::Changed);
    }
    let reply = bridge
        .server
        .request(
            &connection,
            generation,
            wire::Operation::Media,
            scope(&window),
        )
        .map_err(|_| Failure::Unavailable)?;
    if reply.status != wire::Status::Ok {
        return if retained.is_some() {
            Err(Failure::Changed)
        } else {
            Ok(None)
        };
    }
    let returned = reply.window.ok_or(Failure::Changed)?;
    let mut media = reply.media.ok_or(Failure::Unavailable)?;
    // Many ordinary HTML players do not publish MediaSession metadata. The already-bound
    // browser tab title is an allowed metadata fallback, never a DOM text scrape.
    if media.title.trim().is_empty() {
        media.title = returned.tab.title.clone();
    }
    if !matches_bounds(&returned, &target)
        || returned.tab.url != window.tab.url
        || !native_current(app, &target, retained.is_none(), Some(returned.clone()))
        || !valid()
    {
        return Err(Failure::Changed);
    }
    let identity = Identity {
        target: target.clone(),
        connection,
        window: returned,
        media: media.clone(),
    };
    Ok(Some(Track {
        app: target.process.bundle_id,
        pid: target.process.pid,
        launch: (f64::from_bits(target.process.launch_time_bits) + 978307200.).to_string(),
        track: media.id,
        title: media.title,
        artist: media.artist,
        playing: media.playing,
        browser: None,
        companion: Some(identity),
        art: None,
        artwork_url: None,
    }))
}
pub(super) fn query(
    app: &AppHandle,
    generation: u64,
    prior: Option<&Track>,
    valid: &dyn Fn() -> bool,
) -> Result<Option<Track>, Failure> {
    read(app, generation, prior, valid)
}
pub(super) fn control(
    app: &AppHandle,
    generation: u64,
    displayed: &Track,
    control: Control,
    valid: &dyn Fn() -> bool,
    gate: broker::Gate,
) -> Result<(), Failure> {
    let binding = displayed.companion.as_ref().ok_or(Failure::Changed)?;
    let fresh = read(app, generation, Some(displayed), valid)?.ok_or(Failure::Changed)?;
    let current = fresh.companion.as_ref().ok_or(Failure::Changed)?;
    if current.media.id != binding.media.id
        || fresh.playing != displayed.playing
        || current.window.tab.url != binding.window.tab.url
    {
        return Err(Failure::Changed);
    }
    let action = match control {
        Control::PlayPause => {
            if displayed.playing {
                wire::Action::Pause
            } else {
                wire::Action::Play
            }
        }
        Control::Next if current.media.can_next => wire::Action::Next,
        Control::Previous if current.media.can_previous => wire::Action::Previous,
        _ => return Err(Failure::Unavailable),
    };
    if !valid() || !native_current(app, &current.target, false, Some(current.window.clone())) {
        return Err(Failure::Cancelled);
    }
    let mut scope = scope(&current.window);
    scope.media_id = Some(current.media.id.clone());
    scope.action = Some(action);
    let bridge = app.try_state::<Bridge>().ok_or(Failure::Unavailable)?;
    let reply = bridge
        .server
        .request_guarded(&current.connection, generation, scope, gate)
        .map_err(|_| Failure::Unavailable)?;
    // Never retry after submission, even when a late validation fails.
    if reply.status != wire::Status::Ok
        || !valid()
        || !native_current(app, &current.target, false, Some(current.window.clone()))
    {
        return Err(Failure::Changed);
    }
    let window = reply.window.ok_or(Failure::Changed)?;
    let media = reply.media.ok_or(Failure::Changed)?;
    if !matches_bounds(&window, &current.target)
        || window.tab.url != current.window.tab.url
        || matches!(action, wire::Action::Play) && !media.playing
        || matches!(action, wire::Action::Pause) && media.playing
    {
        return Err(Failure::Changed);
    }
    Ok(())
}
pub(super) fn capabilities(track: &Track) -> Option<(bool, bool)> {
    track
        .companion
        .as_ref()
        .map(|b| (b.media.can_next, b.media.can_previous))
}

/// Keep the inspected YouTube controls (including its verified skip buttons) when both
/// adapters independently identify the same native process and canonical video. Never merge
/// capabilities across unrelated players or downgrade a companion target to a guessed source.
pub(super) fn prefer_inspected_player(
    paired: Option<Track>,
    legacy: Option<Track>,
) -> Result<Option<Track>, Failure> {
    match (paired, legacy) {
        (Some(p), Some(l)) => {
            let url = p.companion.as_ref().map(|b| b.window.tab.url.as_str());
            if p.pid == l.pid
                && p.app == l.app
                && p.launch == l.launch
                && source::same_video(url, Some(&l.track))
            {
                Ok(Some(l))
            } else {
                Err(Failure::Changed)
            }
        }
        (p, l) => Ok(p.or(l)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_track_requires_native_owned_exact_player_and_process_identity() {
        let target = Target {
            window_id: 4,
            process: privacy::ProcessIdentity {
                pid: 42,
                bundle_id: "org.mozilla.firefox".into(),
                launch_time_bits: 1000f64.to_bits(),
            },
            quartz_points: target::Rect::new(-1000., 0., 800., 600.).unwrap(),
        };
        let media = wire::Media {
            id: "3".repeat(32),
            title: "Synthetic lesson".into(),
            artist: String::new(),
            playing: true,
            position_sec: 4.,
            can_next: false,
            can_previous: false,
        };
        let window = wire::Window {
            id: 99,
            focused: false,
            incognito: false,
            left: -1000.,
            top: 0.,
            width: 800.,
            height: 600.,
            tab: wire::Tab {
                id: 8,
                url: "https://example.com/lesson".into(),
                title: "Lesson".into(),
                document_id: "2".repeat(32),
            },
        };
        assert!(matches_bounds(&window, &target));
        let mut track = Track {
            app: target.process.bundle_id.clone(),
            pid: 42,
            launch: "978308200".into(),
            track: media.id.clone(),
            title: media.title.clone(),
            artist: String::new(),
            playing: true,
            browser: None,
            companion: Some(Identity {
                target,
                connection: "1".repeat(32),
                window,
                media,
            }),
            art: None,
            artwork_url: None,
        };
        assert!(accepts(&track));
        assert!(track.view().is_some());
        assert_eq!(capabilities(&track), Some((false, false)));
        for mutation in 0..4 {
            let mut changed = track.clone();
            match mutation {
                0 => changed.pid += 1,
                1 => changed.track = "4".repeat(32),
                2 => changed.launch = "978308201".into(),
                _ => changed.playing = false,
            }
            assert!(!accepts(&changed));
            assert!(changed.view().is_none());
        }
        let mut paired = track.clone();
        paired.companion.as_mut().unwrap().window.tab.url =
            "https://www.youtube.com/watch?v=aZ09_-bcDEF&t=9".into();
        let mut legacy = paired.clone();
        legacy.track = "https://www.youtube.com/watch?v=aZ09_-bcDEF".into();
        legacy.companion = None;
        assert_eq!(
            prefer_inspected_player(Some(paired.clone()), Some(legacy.clone()))
                .unwrap()
                .unwrap()
                .track,
            legacy.track
        );
        legacy.launch = "978308201".into();
        assert_eq!(
            prefer_inspected_player(Some(paired), Some(legacy)),
            Err(Failure::Changed)
        );
        track.companion = None;
        assert!(!accepts(&track));
        assert!(track.view().is_none());
    }
}
