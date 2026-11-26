//! Explicit, memory-only redacted clip preview. Only the bundled Clip surface may fetch the
//! nonce image or commit its crop. Opening a preview never uploads or saves anything.
use super::{
    capture,
    capture_session::{self, NativeFrame},
    overlay, runtime, service_call,
};
use crate::screen::{
    base64,
    destination::Place,
    frame::ScreenRect,
    image,
    ink::{self, DrawnInk, InkTool},
    protocol::{self, ClipHead, ClipSource, EntryHead},
    secret::SecretBytes,
    surfaces::Surface,
};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    http::{Request, Response},
    ipc::CapabilityBuilder,
    AppHandle, Manager, UriSchemeContext, WebviewWindow,
};
pub const SCHEME: &str = "mewclip";
struct Draft {
    source: ClipSource,
    frame: Arc<NativeFrame>,
    nonce: String,
    stamp: [u8; 32],
    preview: SecretBytes,
    ink: DrawnInk,
    entry: Option<EntryHead>,
    destination: Option<Place>,
    revision: u64,
    open: bool,
}
#[derive(Default)]
struct Clips {
    draft: Mutex<Option<Draft>>,
    revision: AtomicU64,
}
fn state(app: &AppHandle) -> Result<tauri::State<'_, Clips>, String> {
    app.try_state().ok_or_else(|| "Clips are not ready.".into())
}
pub fn setup(app: &AppHandle) -> Result<(), String> {
    app.manage(Clips::default());
    app.add_capability(
        CapabilityBuilder::new("mac-clip")
            .local(true)
            .window(Surface::Clip.label())
            .permission("allow-screen-clip-ready")
            .permission("allow-screen-clip-save")
            .permission("allow-screen-clip-cancel"),
    )
    .map_err(|_| "Couldn't configure clip preview.".to_owned())?;
    // TTL removes the owned pixels even if the student never closes the preview.
    let app = app.clone();
    std::thread::Builder::new()
        .name("neb-clip-expiry".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(250));
            let expired = state(&app).ok().is_some_and(|s| {
                let mut draft = s.draft.lock().unwrap_or_else(|p| p.into_inner());
                if draft.as_ref().is_some_and(|d| !live(&app, d)) {
                    draft.take();
                    true
                } else {
                    false
                }
            });
            if expired {
                hide(&app);
            }
        })
        .map_err(|_| "Couldn't start clip expiry.".to_owned())?;
    Ok(())
}
fn live(app: &AppHandle, draft: &Draft) -> bool {
    let Ok(runtime) = runtime::of(app) else {
        return false;
    };
    let (config, reset) = runtime.snapshot();
    Instant::now() < draft.frame.expires_at()
        && !reset
        && config.is_on()
        && !config.paused
        && config.privacy.show_in_captures
        && runtime.generation.load(Ordering::Acquire) == draft.frame.generation
        && state(app).is_ok_and(|s| s.revision.load(Ordering::Acquire) == draft.revision)
}
fn hide(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = overlay::dispatch(
            &handle,
            Surface::Clip,
            "mew:clip-reset",
            &serde_json::json!({}),
        );
        if let Some(window) = handle.get_webview_window(Surface::Clip.label()) {
            let _ = overlay::hide(&window);
        }
    });
}
pub fn cancel_all(app: &AppHandle) {
    if let Ok(s) = state(app) {
        s.revision.fetch_add(1, Ordering::AcqRel);
        s.draft.lock().unwrap_or_else(|p| p.into_inner()).take();
    }
    hide(app);
}
pub fn from_ink(app: AppHandle) -> Result<(), String> {
    let (frame, _actions, ink) = super::annotate::prepare_save(&app)?;
    from_shared_frame(&app, frame, ink, None, None)
}
/// Worker-only; `ink` is already in image-local pixels, never global/display coordinates.
pub fn from_frame(
    app: &AppHandle,
    frame: NativeFrame,
    ink: DrawnInk,
    entry: Option<EntryHead>,
    destination: Option<Place>,
) -> Result<(), String> {
    from_shared_frame(app, Arc::new(frame), ink, entry, destination)
}

pub fn from_shared_frame(
    app: &AppHandle,
    frame: Arc<NativeFrame>,
    ink: DrawnInk,
    entry: Option<EntryHead>,
    destination: Option<Place>,
) -> Result<(), String> {
    if !capture_session::is_current(app, &frame) && !capture_session::is_stored_current(app, &frame)
    {
        return Err("The clip's screen changed. Capture it again.".into());
    }
    let stamp = service_call::credential_stamp(app).map_err(|e| e.to_string())?;
    let small = image::downscale_bgra_to_bgr(&frame.captured.pixels, 1600);
    let preview =
        capture::encode_jpeg(&small, 0.85).map_err(|_| "Couldn't encode clip preview.")?;
    if !capture_session::is_current(app, &frame) && !capture_session::is_stored_current(app, &frame)
    {
        return Err("The clip was cancelled.".into());
    }
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "Couldn't create clip preview.")?;
    let nonce = base64::encode_url_safe(&random);
    let s = state(app)?;
    let revision = s.revision.fetch_add(1, Ordering::AcqRel) + 1;
    let source = super::source_meta::read(app, &frame);
    *s.draft.lock().unwrap_or_else(|p| p.into_inner()) = Some(Draft {
        source,
        frame,
        nonce,
        stamp,
        preview,
        ink,
        entry,
        destination,
        revision,
        open: true,
    });
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if state(&handle).is_ok_and(|s| s.revision.load(Ordering::Acquire) == revision) {
            if let Ok(window) = overlay::ensure(&handle, Surface::Clip) {
                let _ = overlay::dispatch(
                    &handle,
                    Surface::Clip,
                    "mew:clip-open",
                    &serde_json::json!({}),
                );
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    })
    .map_err(|_| "Couldn't open clip preview.".to_owned())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInfo {
    image_url: String,
    frame: [f32; 2],
    crop: Option<[f32; 4]>,
    strokes: Vec<PreviewStroke>,
    cards: Vec<[f32; 4]>,
    source: PreviewSource,
    place: Option<String>,
    expires_in_ms: u64,
}
#[derive(Serialize)]
struct PreviewStroke {
    tool: &'static str,
    color: String,
    width: f32,
    points: Vec<[f32; 4]>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewSource {
    app: String,
    title: Option<String>,
    link: Option<String>,
    include_link: bool,
}
#[tauri::command]
pub fn screen_clip_ready(window: WebviewWindow) -> Result<PreviewInfo, String> {
    overlay::require_surface(&window, Surface::Clip)?;
    let s = state(window.app_handle())?;
    let draft = s.draft.lock().unwrap_or_else(|p| p.into_inner());
    let d = draft
        .as_ref()
        .filter(|d| live(window.app_handle(), d))
        .ok_or("This preview has expired.")?;
    let p = &d.frame.captured.pixels;
    Ok(PreviewInfo {
        image_url: format!("mewclip://localhost/{}/frame.jpg", d.nonce),
        frame: [p.width as f32, p.height as f32],
        crop: ink::default_crop(
            d.ink
                .bbox
                .unwrap_or([0., 0., p.width as f32, p.height as f32]),
            &d.frame.server_meta(),
        ),
        strokes: d
            .ink
            .strokes
            .iter()
            .map(|s| PreviewStroke {
                tool: match s.tool {
                    InkTool::Pen => "pen",
                    InkTool::Highlighter => "highlighter",
                },
                color: s.color.clone(),
                width: s.width,
                points: s.points.clone(),
            })
            .collect(),
        cards: d.ink.cards.clone(),
        source: PreviewSource {
            app: d.frame.target.process.bundle_id.clone(),
            title: d.source.title.clone(),
            link: d.source.url.clone(),
            include_link: d.source.url.is_some(),
        },
        place: d.destination.as_ref().map(Place::label),
        expires_in_ms: d
            .frame
            .expires_at()
            .saturating_duration_since(Instant::now())
            .as_millis() as u64,
    })
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
    if ctx.webview_label() != Surface::Clip.label()
        || request.method() != "GET"
        || request.uri().query().is_some()
    {
        return miss();
    }
    let Some(s) = ctx.app_handle().try_state::<Clips>() else {
        return miss();
    };
    let draft = s.draft.lock().unwrap_or_else(|p| p.into_inner());
    let Some(d) = draft.as_ref().filter(|d| live(ctx.app_handle(), d)) else {
        return miss();
    };
    if request.uri().path() != format!("/{}/frame.jpg", d.nonce) {
        return miss();
    }
    Response::builder()
        .status(200)
        .header("Content-Type", "image/jpeg")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(d.preview.as_slice().to_vec())
        .unwrap_or_else(|_| miss())
}
#[tauri::command]
pub async fn screen_clip_save(
    window: WebviewWindow,
    crop: [f32; 4],
    include_notes: bool,
    include_link: bool,
) -> Result<(), String> {
    overlay::require_surface(&window, Surface::Clip)?;
    let app = window.app_handle().clone();
    let draft = state(&app)?
        .draft
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
        .ok_or("This preview has expired.")?;
    hide(&app);
    tauri::async_runtime::spawn_blocking(move || {
        save(&app, draft, crop, include_notes, include_link)
    })
    .await
    .map_err(|_| "Couldn't save clip.".to_owned())?
}
fn save(
    app: &AppHandle,
    draft: Draft,
    crop: [f32; 4],
    include_notes: bool,
    _include_link: bool,
) -> Result<(), String> {
    let valid = || live(app, &draft);
    if !valid() || service_call::credential_stamp(app).map_err(|e| e.to_string())? != draft.stamp {
        return Err("This preview has expired or the account changed.".into());
    }
    let p = &draft.frame.captured.pixels;
    let crop = checked_crop(crop, p.width, p.height).ok_or("Choose a valid crop.")?;
    let cropped = image::crop(p, crop.0, crop.1, crop.2, crop.3);
    if draft.entry.is_some()
        && (image::looks_blank(&cropped)
            || draft.frame.captured.blacked_out.iter().any(|r| {
                r.left < crop.2 && crop.0 < r.right && r.top < crop.3 && crop.1 < r.bottom
            }))
    {
        return Err("Choose a readable area that doesn't cross a protected window.".into());
    }
    let resized = image::downscale_bgra_to_bgr(&cropped, 2400);
    let jpeg = capture::encode_jpeg(&resized, 0.85).map_err(|_| "Couldn't encode clip.")?;
    let crop_rect = [
        crop.0 as f32,
        crop.1 as f32,
        (crop.2 - crop.0) as f32,
        (crop.3 - crop.1) as f32,
    ];
    let scale = resized.width as f32 / (crop.2 - crop.0) as f32;
    let kept = if include_notes {
        ink::clip_strokes_kept(
            &draft.ink.strokes,
            &draft.frame.server_meta(),
            crop_rect,
            scale,
        )
    } else {
        vec![]
    };
    let entry = draft.entry.as_ref().map(|entry| {
        let mut entry = entry.clone();
        entry.stroke_steps = kept
            .iter()
            .map(|(index, _)| entry.stroke_steps.get(*index).copied().unwrap_or(0))
            .collect();
        entry
    });
    let config = runtime::of(app)?.snapshot().0;
    let text = draft
        .frame
        .text()
        .text_in(
            ScreenRect {
                left: crop.0 as i32,
                top: crop.1 as i32,
                right: crop.2 as i32,
                bottom: crop.3 as i32,
            },
            &config.privacy.redaction,
        )
        .chars()
        .take(8000)
        .collect();
    let head = ClipHead {
        pixel_ratio: 1.,
        strokes: kept.into_iter().map(|(_, stroke)| stroke).collect(),
        source: {
            let mut source = draft.source.clone();
            if !_include_link {
                source.url = None;
                source.timestamp_sec = None;
            }
            source
        },
        ocr_text: text,
        entry,
        destination: draft.destination.as_ref().map(Into::into),
    };
    let body = protocol::clip_body(&head, jpeg.as_slice(), resized.width, resized.height);
    let cancelled = || !valid();
    if service_call::credential_stamp(app).map_err(|e| e.to_string())? != draft.stamp {
        return Err("The account changed.".into());
    }
    let reply = service_call::post_bound(
        app,
        "api/screen/clips",
        body.as_slice(),
        &draft.stamp,
        &cancelled,
    )
    .map_err(|e| e.to_string())?;
    if !valid() || service_call::credential_stamp(app).map_err(|e| e.to_string())? != draft.stamp {
        return Err("The clip was cancelled.".into());
    }
    let id = protocol::parse_clip_created(reply.as_slice())
        .ok_or("Neb sent an unexpected clip reply.")?;
    super::handoff_runtime::record_clip(
        app,
        &resized,
        &head,
        ScreenRect {
            left: crop.0 as i32,
            top: crop.1 as i32,
            right: crop.2 as i32,
            bottom: crop.3 as i32,
        },
        draft.frame.text(),
        draft.stamp,
    );
    let event = if head.entry.is_some() {
        crate::screen::page::ENTRY_SAVED
    } else {
        crate::screen::page::CLIP_SAVED
    };
    crate::screen::page::dispatch(
        app,
        event,
        serde_json::json!({"clipId":id,"open":draft.open}),
    );
    Ok(())
}

/// Circle's configured automatic-save toast or its explicit Save button. This is restricted
/// to a native-owned snapshot; the card cannot supply image bytes or an account grant.
pub fn save_entry(
    app: &AppHandle,
    frame: Arc<NativeFrame>,
    ink: DrawnInk,
    entry: EntryHead,
    destination: Option<Place>,
    stamp: [u8; 32],
    open: bool,
) -> Result<(), String> {
    if !capture_session::is_current(app, &frame) && !capture_session::is_stored_current(app, &frame)
    {
        return Err("The selected screen is no longer current.".into());
    }
    let meta = frame.server_meta();
    let crop = ink::default_crop(
        ink.bbox.unwrap_or([
            0.,
            0.,
            meta.bounds.width() as f32,
            meta.bounds.height() as f32,
        ]),
        &meta,
    )
    .ok_or("Choose an area to save.")?;
    let s = state(app)?;
    let revision = s.revision.fetch_add(1, Ordering::AcqRel) + 1;
    let source = super::source_meta::read(app, &frame);
    let draft = Draft {
        source,
        frame,
        nonce: String::new(),
        stamp,
        preview: SecretBytes::zeroed(0),
        ink,
        entry: Some(entry),
        destination,
        revision,
        open,
    };
    let links = runtime::of(app)?.snapshot().0.circle.include_source_link;
    save(app, draft, crop, true, links)
}
fn checked_crop(crop: [f32; 4], width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
    if crop.iter().any(|n| !n.is_finite())
        || crop[0] < 0.
        || crop[1] < 0.
        || crop[2] < 8.
        || crop[3] < 8.
        || crop[0] + crop[2] > width as f32
        || crop[1] + crop[3] > height as f32
    {
        return None;
    }
    let (l, t, r, b) = (
        crop[0].floor() as u32,
        crop[1].floor() as u32,
        (crop[0] + crop[2]).ceil() as u32,
        (crop[1] + crop[3]).ceil() as u32,
    );
    (r <= width && b <= height && r > l && b > t).then_some((l, t, r, b))
}
#[tauri::command]
pub fn screen_clip_cancel(window: WebviewWindow) -> Result<(), String> {
    overlay::require_surface(&window, Surface::Clip)?;
    cancel_all(window.app_handle());
    Ok(())
}

/// DO IT's explicit save-recipe intent commits its redacted capture and structured text.
/// Native-only: no page can provide pixels or authorize a new capture through this helper.
pub fn save_capture_with_text(
    app: &AppHandle,
    frame: NativeFrame,
    text: &str,
    destination: Option<Place>,
) -> Result<String, String> {
    let stamp = service_call::credential_stamp(app).map_err(|e| e.to_string())?;
    let current = || capture_session::is_current(app, &frame);
    if !current() {
        return Err("The recipe screen changed.".into());
    }
    let head = ClipHead {
        pixel_ratio: 1.,
        strokes: vec![],
        source: ClipSource {
            app: frame
                .server_meta()
                .app
                .unwrap_or_else(|| "unknown.exe".into()),
            title: None,
            url: None,
            timestamp_sec: None,
            captured_at: rfc3339(SystemTime::now()),
        },
        ocr_text: text.chars().take(8000).collect(),
        entry: None,
        destination: destination.as_ref().map(Into::into),
    };
    let (width, height) = frame.captured.metadata.encoded_pixels;
    let body = protocol::clip_body(&head, frame.captured.jpeg.as_slice(), width, height);
    let reply = service_call::post_bound(app, "api/screen/clips", body.as_slice(), &stamp, &|| {
        !current()
    })
    .map_err(|e| e.to_string())?;
    if !current() || service_call::credential_stamp(app).ok() != Some(stamp) {
        return Err("The recipe save was cancelled.".into());
    }
    let id =
        protocol::parse_clip_created(reply.as_slice()).ok_or("Neb sent an invalid saved clip.")?;
    crate::screen::page::dispatch(
        app,
        crate::screen::page::CLIP_SAVED,
        serde_json::json!({"clipId":id,"open":false}),
    );
    Ok(id)
}
pub fn rfc3339(time: SystemTime) -> String {
    let secs = time.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rest) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}
/// The native spoken Save command can save a whole redacted view, or re-place existing ink,
/// and resolve an explicitly named notebook destination without silently guessing a place.
pub fn save_request(app: &AppHandle, words: &str) -> Result<(), String> {
    let (frame, ink) = if super::annotate::has_recent(app) {
        let (frame, _, ink) = super::annotate::prepare_save(app)?;
        (frame, ink)
    } else {
        let generation = runtime::of(app)?.generation.load(Ordering::Acquire);
        let frame =
            capture_session::capture_window(app, super::pipeline::Intent::Clip, generation)?;
        let (w, h) = frame.captured.metadata.captured_pixels;
        (
            Arc::new(frame),
            DrawnInk {
                id: 0,
                strokes: vec![],
                cards: vec![],
                bbox: Some([0., 0., w as f32, h as f32]),
                step: None,
            },
        )
    };
    let stamp = service_call::credential_stamp(app).map_err(|e| e.to_string())?;
    let current = || {
        Instant::now() < frame.expires_at()
            && runtime::of(app)
                .is_ok_and(|r| r.generation.load(Ordering::Acquire) == frame.generation)
            && service_call::credential_stamp(app).ok() == Some(stamp)
    };
    let destination = if let Some(phrase) = crate::screen::destination::save_to_phrase(words) {
        let body = serde_json::to_vec(&serde_json::json!({"phrase":phrase}))
            .map_err(|_| "Invalid destination.")?;
        let reply = service_call::post_bound(
            app,
            "api/screen/destinations/resolve",
            &body,
            &stamp,
            &|| !current(),
        )
        .map_err(|e| e.to_string())?;
        use crate::screen::destination::Resolution;
        match crate::screen::destination::parse_resolve_reply(reply.as_slice())
            .ok_or("Neb sent an invalid destination.")?
        {
            Resolution::Resolved { place, .. } => Some(place),
            Resolution::Choose(choices) => {
                let choices = choices.into_iter().take(10).collect::<Vec<_>>();
                let labels = choices.iter().map(Place::label).collect::<Vec<_>>();
                let reply = super::chores::native(
                    &[
                        "choose".into(),
                        "Choose a notebook destination".into(),
                        serde_json::to_string(&labels).map_err(|_| "Invalid destination.")?,
                    ],
                    &current,
                    Duration::from_secs(60),
                )?;
                let reply: serde_json::Value = serde_json::from_slice(reply.as_slice())
                    .map_err(|_| "Invalid destination picker reply.")?;
                let index = reply
                    .get("index")
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|n| usize::try_from(n).ok())
                    .ok_or("Saving was cancelled.")?;
                Some(
                    choices
                        .get(index)
                        .ok_or("Choose a valid destination.")?
                        .clone(),
                )
            }
            Resolution::Missing { mut parent, title } => {
                let reply = super::chores::native(
                    &[
                        "dialog".into(),
                        "Create a chapter?".into(),
                        format!(
                            "Create {title} in {} and save this clip there?",
                            parent.label()
                        ),
                        "Create and save".into(),
                    ],
                    &current,
                    Duration::from_secs(60),
                )?;
                let reply: serde_json::Value = serde_json::from_slice(reply.as_slice())
                    .map_err(|_| "Invalid chapter confirmation reply.")?;
                if reply.get("confirmed").and_then(serde_json::Value::as_bool) != Some(true) {
                    return Err("Saving was cancelled.".into());
                }
                parent.create = Some(title);
                Some(parent)
            }
            Resolution::None => {
                return Err("I couldn't find that notebook destination. Try its full name.".into())
            }
        }
    } else {
        None
    };
    if !current() {
        return Err("The clip expired or the account changed.".into());
    }
    from_shared_frame(app, frame, ink, None, destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crop_rejects_untrusted_or_outside_coordinates() {
        assert_eq!(
            checked_crop([1.2, 2.3, 8., 9.], 100, 100),
            Some((1, 2, 10, 12))
        );
        for crop in [
            [f32::NAN, 0., 10., 10.],
            [-1., 0., 10., 10.],
            [0., 0., 0., 10.],
            [99., 0., 10., 10.],
            [0., 99., 10., 10.],
        ] {
            assert!(checked_crop(crop, 100, 100).is_none());
        }
    }
    #[test]
    fn utc_dates_are_real() {
        assert_eq!(rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(
            rfc3339(UNIX_EPOCH + Duration::from_secs(951782400)),
            "2000-02-29T00:00:00Z"
        );
    }
}
