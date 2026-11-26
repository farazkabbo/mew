//! Save-only native provenance. No document metadata is read at installation or during Ask.
use super::{
    capture_session::{self, NativeFrame},
    hand_policy_ax as ax, runtime,
};
use crate::screen::{protocol::ClipSource, source};
use std::{
    sync::mpsc,
    time::{Duration, Instant, SystemTime},
};
use tauri::AppHandle;
pub fn read(app: &AppHandle, frame: &NativeFrame) -> ClipSource {
    let mut out = ClipSource {
        app: frame
            .server_meta()
            .app
            .unwrap_or_else(|| "unknown.exe".into()),
        title: None,
        url: None,
        timestamp_sec: None,
        captured_at: super::clip::rfc3339(SystemTime::now()),
    };
    let target = frame.target.clone();
    let generation = frame.generation;
    let app = app.clone();
    let handle = app.clone();
    let (tx, rx) = mpsc::sync_channel(1);
    let deadline = Instant::now() + Duration::from_millis(450);
    let _ = app.run_on_main_thread(move || {
        let valid = || {
            Instant::now() < deadline
                && (capture_session::target_is_current_main(&handle, &target, generation)
                    || capture_session::stored_target_current_main(&handle, &target, generation))
        };
        if !valid() {
            return;
        }
        let result =
            if super::app_policy::has_inspected_browser_dictionary(&target.process.bundle_id) {
                let request = super::browser_mode::FocusRequest {
                    bundle: target.process.bundle_id.clone(),
                    pid: target.process.pid,
                    launch: f64::from_bits(target.process.launch_time_bits).to_string(),
                    cg_window_id: target.window_id,
                    generation,
                };
                super::browser_mode::saved_source(&request, target.quartz_points, &valid)
                    .map(|(title, url)| (Some(title), Some(url)))
            } else {
                let title = (|| {
                    let app = ax::application(target.process.pid)?;
                    let window = ax::attr(app.0, "AXFocusedWindow", deadline)?;
                    let p = ax::pair(ax::attr(window.0, "AXPosition", deadline)?.0, 1)?;
                    let size = ax::pair(ax::attr(window.0, "AXSize", deadline)?.0, 2)?;
                    if super::target::Rect::new(p.a, p.b, size.a, size.b)
                        != Some(target.quartz_points)
                    {
                        return None;
                    }
                    ax::string_bounded(ax::attr(window.0, "AXTitle", deadline)?.0, 200)
                })();
                Some((title, None))
            };
        if valid() {
            let _ = tx.send(result);
        }
    });
    if let Ok(Some((title, url))) = rx.recv_timeout(Duration::from_millis(500)) {
        let rules = runtime::of(&app)
            .map(|r| r.snapshot().0.privacy.redaction)
            .unwrap_or_default();
        out.title = title
            .and_then(|title| source::clean_title(&title, &out.app))
            .filter(|title| {
                crate::screen::privacy::detect::find_sensitive(title, &rules).is_empty()
            });
        if runtime::of(&app).is_ok_and(|r| r.snapshot().0.circle.include_source_link) {
            out.url = url
                .and_then(|url| source::sanitize_url(&url))
                .map(|url| url.to_string());
        }
    }
    out
}
