//! Worker-only production capture orchestration. Metadata is sampled freshly and bounded on
//! AppKit's main queue. No permission requests, IPC, persistence, provider calls or raw previews.
use super::{
    app_policy, call_signals, capture,
    indicator::{Indicator, IndicatorCheck},
    pipeline::{self, Evidence, Intent, PolicyProof, Request, Target},
    privacy, runtime,
    target::{self, Display, PixelRect, Rect},
};
use crate::screen::{
    config::{CaptureScope, ScreenConfig},
    frame::{FrameMeta, ScreenRect, TargetKind, Timings},
    screen_text::ScreenText,
};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc, Arc, Weak,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
#[path = "capture_session_binding.rs"]
mod binding;

const SAMPLE_BUDGET: Duration = Duration::from_millis(450);
const REQUEST_BUDGET: Duration = Duration::from_secs(15);
unsafe extern "C" {
    fn pthread_main_np() -> i32;
    fn CGEventSourceCounterForEventType(state: i32, event: u32) -> u32;
}

/// Passive event counters contain no keys, text, locations or event payloads. They only
/// invalidate stale visual context; they are never affirmative privacy authorization.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ContentStamp(pub(crate) [u32; 4]);
pub(crate) fn content_stamp() -> ContentStamp {
    ContentStamp([10, 22, 1, 3].map(|kind| unsafe { CGEventSourceCounterForEventType(0, kind) }))
}

#[derive(Default)]
pub struct CaptureSession {
    serial: AtomicU64,
}
pub fn setup(app: &AppHandle) -> Result<(), String> {
    if app.manage(CaptureSession::default()) {
        Ok(())
    } else {
        Err("Mac capture is already initialized.".into())
    }
}
fn worker() -> Result<(), String> {
    // SAFETY: pthread_main_np is a scalar thread query, with no permission side effects.
    if unsafe { pthread_main_np() } == 0 {
        Ok(())
    } else {
        Err("Mac capture must run on a worker.".into())
    }
}

/// Owned pixels stay exclusively in Rust, and are wiped with the frame. The private request
/// binds subsequent uses to the original intent and target. The capture indicator is released
/// before returning; later uses recheck metadata only and cannot acquire new pixels.
pub struct NativeFrame {
    pub captured: pipeline::Captured,
    pub target: Target,
    pub generation: u64,
    request: Request,
    displays: Vec<Display>,
    content_stamp: ContentStamp,
    playback: Option<super::media::PlaybackSnapshot>,
    tutor_position: AtomicU32,
}
/// A lease is minted only while native Circle takes ownership of a fresh redacted frame.
/// Weak consumers cannot extend ownership; dropping the session revokes all retained uses.
pub struct CircleRetention {
    state: Arc<RetainedCircle>,
}
struct RetainedCircle {
    frame: Arc<NativeFrame>,
    credential: [u8; 32],
    alive: AtomicBool,
}
pub struct CircleGrant(Weak<RetainedCircle>);
impl Clone for CircleGrant {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl Drop for CircleRetention {
    fn drop(&mut self) {
        self.state.alive.store(false, Ordering::Release);
    }
}
impl CircleRetention {
    pub fn grant(&self) -> CircleGrant {
        CircleGrant(Arc::downgrade(&self.state))
    }
}
impl CircleGrant {
    pub fn live(&self) -> bool {
        self.0
            .upgrade()
            .is_some_and(|s| s.alive.load(Ordering::Acquire))
    }
    pub fn matches(&self, frame: &NativeFrame) -> bool {
        self.0.upgrade().is_some_and(|s| {
            s.alive.load(Ordering::Acquire) && std::ptr::eq(s.frame.as_ref(), frame)
        })
    }
}
pub fn retain_circle(
    app: &AppHandle,
    frame: Arc<NativeFrame>,
    credential: [u8; 32],
) -> Result<CircleRetention, String> {
    if frame.request.intent != Intent::Circle
        || !is_current(app, &frame)
        || super::service_call::credential_stamp(app).ok() != Some(credential)
    {
        return Err("The Circle capture cannot be retained.".into());
    }
    Ok(CircleRetention {
        state: Arc::new(RetainedCircle {
            frame,
            credential,
            alive: AtomicBool::new(true),
        }),
    })
}
/// Time alone never extends an ordinary frame. A retained use must carry its explicit exact-
/// frame weak grant, which becomes invalid immediately when its native owner is dropped.
pub fn frame_time_live(frame: &NativeFrame, grant: Option<&CircleGrant>, now: Instant) -> bool {
    grant.map_or(now < frame.expires_at(), |g| g.matches(frame))
}
pub fn retained_current(app: &AppHandle, frame: &NativeFrame, grant: &CircleGrant) -> bool {
    if worker().is_err() {
        return false;
    }
    let Some(owned) = grant
        .0
        .upgrade()
        .filter(|s| s.alive.load(Ordering::Acquire) && std::ptr::eq(s.frame.as_ref(), frame))
    else {
        return false;
    };
    let current = || {
        owned.alive.load(Ordering::Acquire)
            && super::service_call::credential_stamp(app).ok() == Some(owned.credential)
            && current_config(app, frame.generation).is_ok()
    };
    if !current() {
        return false;
    }
    let mut request = frame.request.clone();
    request.issued_at = Instant::now();
    // This path performs metadata validation only: no indicator/capture service is reachable.
    if let Ok(runtime) = runtime::of(app) {
        if pipeline::revalidate_metadata(&request, &runtime.generation, &mut |r, _| {
            sample(app, r, &frame.displays, None).map_err(|_| pipeline::Error::PolicyUnavailable)
        })
        .is_ok()
            && current()
        {
            return true;
        }
    }
    retained_stored_current(app, owned.clone(), &current)
}
fn retained_stored_current(
    app: &AppHandle,
    owned: Arc<RetainedCircle>,
    current: &dyn Fn() -> bool,
) -> bool {
    let frame = &owned.frame;
    if !current() {
        return false;
    }
    let browser = app_policy::has_inspected_browser_dictionary(&frame.target.process.bundle_id);
    let browser_mode = if browser {
        super::browser_mode::sample_native(
            &super::browser_mode::FocusRequest {
                pid: frame.target.process.pid,
                bundle: frame.target.process.bundle_id.clone(),
                launch: f64::from_bits(frame.target.process.launch_time_bits).to_string(),
                cg_window_id: frame.target.window_id,
                generation: frame.generation,
            },
            frame.target.quartz_points,
            current,
        )
    } else {
        super::browser_mode::Mode::Unknown
    };
    let frame = owned.frame.clone();
    let credential = owned.credential;
    let live = owned.clone();
    let result = on_main(app, move |app, deadline| {
        let config = current_config(app, frame.generation)?;
        if !live.alive.load(Ordering::Acquire)
            || super::service_call::credential_stamp(app).ok() != Some(credential)
            || config.privacy.redaction != frame.request.rules
            || config.privacy.pause_during_calls != frame.request.pause_during_calls
            || !stored_target_current_main(app, &frame.target, frame.generation)
            || target::displays().as_ref() != Some(&frame.displays)
        {
            return Ok(false);
        }
        let class = app_policy::classify_app(&frame.target.process.bundle_id);
        if app_policy::blocked_app(
            &frame.target.process.bundle_id,
            &config.privacy.blocked_apps,
        )
        .is_some()
            || !(class == app_policy::AppClass::SupportedNative
                || browser && browser_mode == super::browser_mode::Mode::Normal)
        {
            return Ok(false);
        }
        // App-specific focused metadata remains inspectable while a local card owns the key
        // window. Unknown/protected fields and unknown browser modes refuse retained use.
        if !binding::focused_window_matches(frame.target.process.pid, frame.target.quartz_points) {
            return Ok(false);
        }
        let focus = privacy::retained_focus(&frame.target.process);
        if focus.focus != crate::screen::privacy::Focus::Ordinary {
            return Ok(false);
        }
        if browser && browser_mode != super::browser_mode::Mode::Normal {
            return Ok(false);
        }
        let valid = || {
            live.alive.load(Ordering::Acquire)
                && Instant::now() < deadline
                && current_config(app, frame.generation).is_ok()
        };
        if config.privacy.pause_during_calls
            && call_signals::sample(deadline, &valid).state
                != call_signals::SignalState::KnownSignalsIdle
        {
            return Ok(false);
        }
        Ok(valid() && stored_target_current_main(app, &frame.target, frame.generation))
    })
    .unwrap_or(false);
    result && current()
}
impl NativeFrame {
    /// True only when the sampled input counters match. This is an invalidation hint,
    /// not proof against animations, remote updates, or every application content change.
    pub fn input_is_unchanged(&self) -> bool {
        self.content_stamp == content_stamp()
    }
    pub(crate) fn content_stamp(&self) -> ContentStamp {
        self.content_stamp
    }
    pub fn expires_at(&self) -> Instant {
        self.request.issued_at + crate::screen::frame::FRAME_TTL
    }
    pub fn player_position(&self) -> Option<u32> {
        self.playback
            .as_ref()
            .and_then(|snapshot| snapshot.position_sec)
    }
    pub fn media_source_url(&self) -> Option<&str> {
        self.playback
            .as_ref()
            .map(|snapshot| snapshot.source_url.as_str())
    }
    pub fn tutor_position(&self) -> Option<u32> {
        self.tutor_position.load(Ordering::Acquire).checked_sub(1)
    }
    pub fn set_tutor_position(&self, position: Option<u32>) {
        self.tutor_position.store(
            position
                .filter(|seconds| *seconds <= 86_400)
                .map_or(0, |seconds| seconds + 1),
            Ordering::Release,
        );
    }
    pub fn text(&self) -> &ScreenText {
        self.captured.text.in_image_pixels()
    }
    /// This protocol metadata is explicitly IMAGE LOCAL. Never pass its rectangles into
    /// Windows global-physical-pixel positioning. macOS overlay placement uses Quartz below.
    pub fn server_meta(&self) -> FrameMeta {
        let (w, h) = self.captured.metadata.captured_pixels;
        let (width, height) = self.captured.metadata.encoded_pixels;
        let bounds = ScreenRect {
            left: 0,
            top: 0,
            right: w as i32,
            bottom: h as i32,
        };
        FrameMeta {
            kind: if self.request.monitor.is_some() {
                TargetKind::Monitor
            } else {
                TargetKind::Window
            },
            app: app_policy::wire_name(&self.target.process.bundle_id).map(str::to_owned),
            bounds,
            monitor: bounds,
            dpi: 96,
            width,
            height,
            timings: Timings::default(),
            video_playing: self.playback.as_ref().map(|snapshot| snapshot.playing),
            window: None,
        }
    }
    pub fn image_rect_to_quartz(&self, rect: PixelRect) -> Option<Rect> {
        image_rect_to_quartz(
            self.captured.metadata.quartz_points,
            self.captured.metadata.captured_pixels,
            rect,
        )
    }
    /// Normalized model coordinates refer to the entire image regardless of JPEG downscale.
    pub fn normalized_rect_to_quartz(
        &self,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Option<Rect> {
        normalized_rect_to_quartz(self.captured.metadata.quartz_points, x, y, width, height)
    }
}
fn normalized_rect_to_quartz(
    bounds: Rect,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Option<Rect> {
    Rect::new(x, y, width, height)?;
    if x < 0. || y < 0. || x + width > 1. || y + height > 1. {
        return None;
    }
    Rect::new(
        bounds.x + x * bounds.width,
        bounds.y + y * bounds.height,
        width * bounds.width,
        height * bounds.height,
    )
}
fn image_rect_to_quartz(
    bounds: Rect,
    (width, height): (u32, u32),
    rect: PixelRect,
) -> Option<Rect> {
    if width == 0
        || height == 0
        || rect.left >= rect.right
        || rect.top >= rect.bottom
        || rect.right > width
        || rect.bottom > height
    {
        return None;
    }
    normalized_rect_to_quartz(
        bounds,
        f64::from(rect.left) / f64::from(width),
        f64::from(rect.top) / f64::from(height),
        f64::from(rect.right - rect.left) / f64::from(width),
        f64::from(rect.bottom - rect.top) / f64::from(height),
    )
}

/// Bounded main-queue dispatch. A timed-out queued closure cannot later acquire pixels or
/// authorize anything; it checks revocation before and after read-only metadata work.
fn on_main<T: Send + 'static>(
    app: &AppHandle,
    read: impl FnOnce(&AppHandle, Instant) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    worker()?;
    let deadline = Instant::now() + SAMPLE_BUDGET;
    let live = Arc::new(AtomicBool::new(true));
    let active = live.clone();
    let handle = app.clone();
    let (tx, rx) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        if !active.load(Ordering::Acquire) || Instant::now() >= deadline {
            return;
        }
        let result = read(&handle, deadline);
        if active.load(Ordering::Acquire) && Instant::now() < deadline {
            let _ = tx.send(result);
        }
    })
    .map_err(|_| "Couldn't sample Mac privacy policy.".to_owned())?;
    let result = rx
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| "Mac privacy checks timed out.".to_owned());
    live.store(false, Ordering::Release);
    result?
}
fn current_config(app: &AppHandle, generation: u64) -> Result<ScreenConfig, String> {
    let runtime = runtime::of(app)?;
    if runtime.generation.load(Ordering::Acquire) != generation {
        return Err("The screen request was cancelled.".into());
    }
    let (config, reset) = runtime.snapshot();
    if reset || !config.is_on() || config.paused {
        return Err("Screen Coach is disabled or paused.".into());
    }
    Ok(config)
}
fn allow_scope(_: &ScreenConfig) -> Result<(), String> {
    Ok(())
}
fn monitor_snapshot(target: &Target, displays: &[Display]) -> Result<pipeline::Monitor, String> {
    let rect = target.quartz_points;
    let display = displays
        .iter()
        .find(|d| {
            d.points.contains(super::target::Point {
                x: rect.x + rect.width / 2.,
                y: rect.y + rect.height / 2.,
            })
        })
        .ok_or("The capture display is unavailable.")?;
    let windows = target::visible_windows()
        .filter(|w| w.len() <= 4096)
        .ok_or("The visible-window privacy inventory is unavailable.")?;
    let windows = windows
        .into_iter()
        .filter(|w| w.pid != std::process::id() as i32)
        .map(|w| pipeline::VisibleWindow {
            id: w.id,
            pid: w.pid,
            bounds: w.bounds,
            layer: w.layer,
        })
        .collect();
    Ok(pipeline::Monitor {
        id: display.id,
        bounds: display.points,
        windows,
    })
}

fn same_target(
    expected: &Target,
    actual: &Target,
    displays: &[Display],
    actual_displays: &[Display],
) -> bool {
    expected == actual && displays == actual_displays
}
fn discover() -> Result<(Target, Vec<Display>), String> {
    let process = privacy::frontmost_process_identity()
        .ok_or("The foreground application is unavailable.")?;
    let app = target::AppIdentity {
        pid: process.pid,
        bundle_id: Some(process.bundle_id.clone()),
    };
    let window =
        target::frontmost_window_candidate(&app).ok_or("The foreground window is unavailable.")?;
    if !binding::focused_window_matches(process.pid, window.bounds) {
        return Err("The focused window could not be verified.".into());
    }
    // Ambiguous coincident windows cannot be bound with the public AX geometry contract.
    let windows =
        target::visible_windows().ok_or("The visible window inventory is unavailable.")?;
    if windows
        .iter()
        .filter(|w| w.pid == process.pid && w.layer == 0 && w.bounds == window.bounds)
        .count()
        != 1
    {
        return Err("The focused window is ambiguous.".into());
    }
    let displays = target::displays()
        .filter(|d| !d.is_empty())
        .ok_or("Display geometry is unavailable.")?;
    if privacy::frontmost_process_identity().as_ref() != Some(&process) {
        return Err("The foreground application changed.".into());
    }
    Ok((
        Target {
            window_id: window.id,
            process,
            quartz_points: window.bounds,
        },
        displays,
    ))
}
/// Lightweight final positioning guard, main-thread only. Full privacy authorization is
/// sampled on the worker immediately before queuing this final native UI operation.
pub(crate) fn target_is_current_main(app: &AppHandle, expected: &Target, generation: u64) -> bool {
    if unsafe { pthread_main_np() } == 0 || current_config(app, generation).is_err() {
        return false;
    }
    capture::permission_granted()
        && privacy::accessibility_trusted()
        && discover().is_ok_and(|(actual, _)| actual == *expected)
}

/// Already-captured-frame grant while the student types into the exact bundled Circle card.
/// This never enters the pixel pipeline and cannot authorize a capture or another surface.
pub fn is_stored_current(app: &AppHandle, frame: &NativeFrame) -> bool {
    if worker().is_err()
        || Instant::now() >= frame.expires_at()
        || frame.target != frame.request.target
        || frame.generation != frame.request.generation
    {
        return false;
    }
    let target = frame.target.clone();
    let displays = frame.displays.clone();
    let generation = frame.generation;
    let expires_at = frame.expires_at();
    on_main(app, move |app, _| {
        if Instant::now() >= expires_at
            || !stored_target_current_main(app, &target, generation)
            || target::displays().as_ref() != Some(&displays)
        {
            return Err("The stored Circle frame is no longer current.".into());
        }
        Ok(())
    })
    .is_ok()
        && Instant::now() < expires_at
}
pub(crate) fn stored_target_current_main(
    app: &AppHandle,
    target: &Target,
    generation: u64,
) -> bool {
    if unsafe { pthread_main_np() } == 0
        || current_config(app, generation).is_err()
        || !capture::permission_granted()
        || !privacy::accessibility_trusted()
    {
        return false;
    }
    let owns_focus = [super::overlay::Surface::Card, super::overlay::Surface::Draw]
        .into_iter()
        .any(|surface| {
            if matches!(surface, super::overlay::Surface::Draw)
                && !super::drawing::keyboard_active(app)
            {
                return false;
            }
            let Some(window) = app.get_webview_window(surface.label()) else {
                return false;
            };
            if super::overlay::require_surface(&window, surface).is_err() {
                return false;
            }
            let mut key = false;
            super::panel::with_window(&window, |native| {
                key = native.isKeyWindow() && native.isVisible();
            });
            key
        });
    owns_focus
        && privacy::process_identity(target.process.pid).as_ref() == Some(&target.process)
        && target::visible_windows().is_some_and(|windows| unique_window(target, &windows))
}

fn unique_window(target: &Target, windows: &[target::WindowSnapshot]) -> bool {
    let mut matching = windows.iter().filter(|window| {
        window.pid == target.process.pid
            && window.bounds == target.quartz_points
            && window.layer == 0
    });
    matching
        .next()
        .is_some_and(|window| window.id == target.window_id)
        && matching.next().is_none()
}
fn call_evidence(pause: bool, state: call_signals::SignalState) -> Evidence {
    if !pause {
        return Evidence::DisabledByLocalPolicy;
    }
    match state {
        call_signals::SignalState::KnownSignalsIdle => Evidence::KnownSignalsIdle,
        call_signals::SignalState::Active => Evidence::Present,
        call_signals::SignalState::Unknown => Evidence::Unknown,
    }
}
fn browser_mode_for_request(app: &AppHandle, request: &Request) -> super::browser_mode::Mode {
    use super::browser_mode::{self, FocusRequest, Mode};
    if !app_policy::has_inspected_browser_dictionary(&request.target.process.bundle_id) {
        return Mode::Unknown;
    }
    let target = request.target.clone();
    let generation = request.generation;
    if !on_main(app, move |app, _| {
        Ok(target_is_current_main(app, &target, generation))
    })
    .unwrap_or(false)
    {
        return Mode::Unknown;
    }
    let valid = || {
        current_config(app, request.generation).is_ok()
            && request.issued_at.elapsed() < request.timeout
    };
    let focus = FocusRequest {
        pid: request.target.process.pid,
        bundle: request.target.process.bundle_id.clone(),
        launch: (f64::from_bits(request.target.process.launch_time_bits) + 978307200.).to_string(),
        cg_window_id: request.target.window_id,
        generation: request.generation,
    };
    let mode = browser_mode::sample_native(&focus, request.target.quartz_points, &valid);
    let target = request.target.clone();
    let generation = request.generation;
    if !valid()
        || !on_main(app, move |app, _| {
            Ok(target_is_current_main(app, &target, generation))
        })
        .unwrap_or(false)
    {
        return Mode::Unknown;
    }
    mode
}
fn sample(
    app: &AppHandle,
    request: &Request,
    displays: &[Display],
    indicator: Option<IndicatorCheck>,
) -> Result<PolicyProof, String> {
    let browser_mode = browser_mode_for_request(app, request);
    let req = request.clone();
    let expected_displays = displays.to_vec();
    on_main(app, move |app, deadline| {
        let config = current_config(app, req.generation)?;
        allow_scope(&config)?;
        if config.privacy.redaction != req.rules
            || config.privacy.pause_during_calls != req.pause_during_calls
        {
            return Err("Capture privacy settings changed.".into());
        }
        let screen_permission = capture::permission_granted();
        let accessibility_permission = privacy::accessibility_trusted();
        if !screen_permission || !accessibility_permission {
            return Err("Screen Recording and Accessibility permissions are required.".into());
        }
        let (actual, actual_displays) = discover()?;
        let monitor = if config.privacy.ask_scope == CaptureScope::Monitor {
            Some(monitor_snapshot(&actual, &actual_displays)?)
        } else {
            None
        };
        if monitor != req.monitor {
            return Err("The visible-window capture inventory changed.".into());
        }
        if !same_target(&req.target, &actual, &expected_displays, &actual_displays) {
            return Err("The capture target changed.".into());
        }
        let focus = privacy::snapshot(&req.target.process);
        let class = app_policy::classify_app(&req.target.process.bundle_id);
        let blocked_application = if class == app_policy::AppClass::Blocked
            || app_policy::blocked_app(&req.target.process.bundle_id, &config.privacy.blocked_apps)
                .is_some()
        {
            Evidence::Present
        } else if class == app_policy::AppClass::SupportedNative
            || (app_policy::has_inspected_browser_dictionary(&req.target.process.bundle_id)
                && browser_mode == super::browser_mode::Mode::Normal)
        {
            Evidence::Clear
        } else {
            Evidence::Unknown
        };
        let private_browsing = match focus.private_browsing {
            app_policy::PrivateState::NotApplicableSupportedNative => Evidence::Clear,
            app_policy::PrivateState::RequiresBrowserEvidence => match browser_mode {
                super::browser_mode::Mode::Normal => Evidence::Clear,
                super::browser_mode::Mode::Private => Evidence::Present,
                _ => Evidence::Unknown,
            },
            _ => Evidence::Unknown,
        };
        let valid = || Instant::now() < deadline && current_config(app, req.generation).is_ok();
        let call_or_share = if req.pause_during_calls {
            call_evidence(true, call_signals::sample(deadline, &valid).state)
        } else {
            Evidence::DisabledByLocalPolicy
        };
        let (after, after_displays) = discover()?;
        if req.monitor.is_some() && Some(monitor_snapshot(&after, &after_displays)?) != req.monitor
        {
            return Err(
                "The visible-window capture inventory changed during privacy checks.".into(),
            );
        }
        if !same_target(&req.target, &after, &expected_displays, &after_displays) || !valid() {
            return Err("The capture target changed during privacy checks.".into());
        }
        let indicator_presented = indicator.map(|i| i.is_presented()).unwrap_or(false);
        // Initial metadata-only preflight has no indicator; it is never handed to pipeline.
        let session = app
            .try_state::<CaptureSession>()
            .ok_or("Mac capture is not initialized.")?;
        let serial = session
            .serial
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_add(1))
            .map_err(|_| "Mac capture serial exhausted.")?
            + 1;
        Ok(PolicyProof {
            monitor,
            sampled_at: Instant::now(),
            sampled_on_main_queue: true,
            serial,
            target: actual,
            intent: req.intent,
            generation: req.generation,
            opted_in: config.is_on(),
            paused: config.paused,
            screen_permission: capture::permission_granted(),
            accessibility_permission: privacy::accessibility_trusted(),
            indicator_presented,
            focus: focus.focus,
            blocked_application,
            private_browsing,
            call_or_share,
            pause_during_calls: config.privacy.pause_during_calls,
        })
    })
}
fn policy_error(_: pipeline::Error) -> String {
    "Screen capture stopped because a current permission, privacy, target, indicator or session check could not be verified.".into()
}

pub fn capture_window(
    app: &AppHandle,
    intent: Intent,
    generation: u64,
) -> Result<NativeFrame, String> {
    worker()?;
    let issued_at = Instant::now();
    let input_stamp = content_stamp();
    let (config, target, displays, monitor) = on_main(app, move |app, _| {
        let config = current_config(app, generation)?;
        allow_scope(&config)?;
        if !capture::permission_granted() || !privacy::accessibility_trusted() {
            return Err("Screen Recording and Accessibility permissions are required.".into());
        }
        let (target, displays) = discover()?;
        let monitor = if config.privacy.ask_scope == CaptureScope::Monitor {
            Some(monitor_snapshot(&target, &displays)?)
        } else {
            None
        };
        Ok((config, target, displays, monitor))
    })?;
    let request = Request {
        target: target.clone(),
        monitor,
        intent,
        generation,
        issued_at,
        timeout: REQUEST_BUDGET,
        rules: config.privacy.redaction,
        pause_during_calls: config.privacy.pause_during_calls,
    };
    let runtime = runtime::of(app)?;
    // Validate before even displaying an indicator. This preflight obtains no pixels.
    pipeline::revalidate_metadata(&request, &runtime.generation, &mut |r, _| {
        sample(app, r, &displays, None).map_err(|_| pipeline::Error::PolicyUnavailable)
    })
    .map_err(policy_error)?;
    let before_playback = playback_for_target(app, &target, generation);
    let indicator = Indicator::begin(
        request
            .monitor
            .as_ref()
            .map(|m| m.bounds)
            .unwrap_or(target.quartz_points),
    )
    .map_err(|_| "The capture indicator could not be shown.")?;
    let check = indicator.check_handle();
    indicator
        .wait_presented(&mut || {
            pipeline::revalidate_metadata(&request, &runtime.generation, &mut |r, _| {
                sample(app, r, &displays, None).map_err(|_| pipeline::Error::PolicyUnavailable)
            })
            .is_ok()
        })
        .map_err(|_| "The capture indicator was not presented in time.")?;
    let captured = pipeline::run(
        &mut pipeline::NativeService,
        &request,
        &runtime.generation,
        &mut |r, _| {
            sample(app, r, &displays, Some(check)).map_err(|_| pipeline::Error::PolicyUnavailable)
        },
    )
    .map_err(policy_error)?;
    drop(indicator);
    if content_stamp() != input_stamp {
        return Err("The screen content changed during capture.".into());
    }
    let playback = before_playback
        .zip(playback_for_target(app, &target, generation))
        .filter(|(before, after)| {
            crate::screen::source::same_video(Some(&before.source_url), Some(&after.source_url))
        })
        .map(|(before, _)| before);
    if content_stamp() != input_stamp {
        return Err("The screen content changed during capture metadata checks.".into());
    }
    Ok(NativeFrame {
        captured,
        target,
        generation,
        request,
        displays,
        content_stamp: input_stamp,
        playback,
        tutor_position: AtomicU32::new(0),
    })
}

fn playback_for_target(
    app: &AppHandle,
    target: &Target,
    generation: u64,
) -> Option<super::media::PlaybackSnapshot> {
    let handle = app.clone();
    let target = target.clone();
    let (tx, rx) = mpsc::sync_channel(1);
    let deadline = Instant::now() + Duration::from_millis(450);
    app.run_on_main_thread(move || {
        let current =
            || Instant::now() < deadline && target_is_current_main(&handle, &target, generation);
        if current() {
            let result =
                super::media::playback_for_target_main(&target, generation, deadline, &current);
            if current() {
                let _ = tx.send(result);
            }
        }
    })
    .ok()?;
    rx.recv_timeout(Duration::from_millis(500)).ok().flatten()
}

/// Call from a worker immediately before transport, persistence, or drawing a delayed result.
/// A prior successful call is never reusable authorization for a later asynchronous use.
pub fn is_current(app: &AppHandle, frame: &NativeFrame) -> bool {
    if worker().is_err()
        || frame.generation != frame.request.generation
        || frame.target != frame.request.target
    {
        return false;
    }
    let Ok(runtime) = runtime::of(app) else {
        return false;
    };
    if frame.request.issued_at.elapsed() >= crate::screen::frame::FRAME_TTL {
        return false;
    }
    let mut request = frame.request.clone();
    request.issued_at = Instant::now();
    pipeline::revalidate_metadata(&request, &runtime.generation, &mut |r, _| {
        sample(app, r, &frame.displays, None).map_err(|_| pipeline::Error::PolicyUnavailable)
    })
    .is_ok()
        && Instant::now() < frame.expires_at()
}

/// Fresh target/privacy authorization for metadata-only annotation watching. It never grants
/// permission to acquire a new frame; capture_window establishes its own indicator lease.
pub fn is_target_current(app: &AppHandle, target: &Target, generation: u64) -> bool {
    if worker().is_err() {
        return false;
    }
    let expected = target.clone();
    let Ok((config, displays, monitor)) = on_main(app, move |app, _| {
        let config = current_config(app, generation)?;
        allow_scope(&config)?;
        let (actual, displays) = discover()?;
        if actual != expected {
            return Err("The annotation target changed.".into());
        }
        let monitor = if config.privacy.ask_scope == CaptureScope::Monitor {
            Some(monitor_snapshot(&actual, &displays)?)
        } else {
            None
        };
        Ok((config, displays, monitor))
    }) else {
        return false;
    };
    let request = Request {
        target: target.clone(),
        monitor,
        intent: Intent::Ask,
        generation,
        issued_at: Instant::now(),
        timeout: REQUEST_BUDGET,
        rules: config.privacy.redaction,
        pause_during_calls: config.privacy.pause_during_calls,
    };
    let Ok(runtime) = runtime::of(app) else {
        return false;
    };
    pipeline::revalidate_metadata(&request, &runtime.generation, &mut |r, _| {
        sample(app, r, &displays, None).map_err(|_| pipeline::Error::PolicyUnavailable)
    })
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::super::privacy::ProcessIdentity;
    use super::*;
    fn target() -> Target {
        Target {
            window_id: 99,
            process: ProcessIdentity {
                pid: 42,
                bundle_id: "com.apple.TextEdit".into(),
                launch_time_bits: 1000f64.to_bits(),
            },
            quartz_points: Rect::new(-1440., -200., 1000., 500.).unwrap(),
        }
    }
    fn retained_fixture(issued_at: Instant) -> Arc<NativeFrame> {
        let target = target();
        Arc::new(NativeFrame {
            captured: pipeline::Captured {
                jpeg: crate::screen::secret::SecretBytes::zeroed(0),
                pixels: crate::screen::image::Pixels {
                    width: 1,
                    height: 1,
                    channels: 4,
                    data: crate::screen::secret::SecretBytes::zeroed(4),
                },
                blacked_out: vec![],
                text: pipeline::LocalText::default(),
                metadata: pipeline::Metadata {
                    quartz_points: target.quartz_points,
                    captured_pixels: (1, 1),
                    encoded_pixels: (1, 1),
                    generation: 7,
                    intent: Intent::Circle,
                },
            },
            request: Request {
                target: target.clone(),
                monitor: None,
                intent: Intent::Circle,
                generation: 7,
                issued_at,
                timeout: REQUEST_BUDGET,
                rules: Default::default(),
                pause_during_calls: true,
            },
            target,
            generation: 7,
            displays: vec![],
            content_stamp: ContentStamp([0; 4]),
            playback: None,
            tutor_position: AtomicU32::new(0),
        })
    }
    #[test]
    fn retained_circle_is_exact_frame_owned_and_revoked_on_owner_drop() {
        let now = Instant::now();
        let frame = retained_fixture(now - Duration::from_secs(120));
        assert!(!frame_time_live(&frame, None, now));
        let owner = CircleRetention {
            state: Arc::new(RetainedCircle {
                frame: frame.clone(),
                credential: [1; 32],
                alive: AtomicBool::new(true),
            }),
        };
        let grant = owner.grant();
        assert!(frame_time_live(&frame, Some(&grant), now));
        let other = retained_fixture(now);
        assert!(!frame_time_live(&other, Some(&grant), now));
        assert!(frame_time_live(&other, None, now));
        drop(owner);
        assert!(!grant.live());
        assert!(!frame_time_live(&frame, Some(&grant), now));
    }
    #[test]
    fn stored_provenance_refuses_a_coincident_replacement_document() {
        let original = target();
        let window = target::WindowSnapshot {
            id: original.window_id,
            pid: original.process.pid,
            bounds: original.quartz_points,
            layer: 0,
            alpha: Some(1.),
        };
        assert!(unique_window(&original, std::slice::from_ref(&window)));
        let mut replacement = window.clone();
        replacement.id += 1;
        assert!(!unique_window(&original, &[window, replacement.clone()]));
        assert!(!unique_window(&original, &[replacement]));
    }
    #[test]
    fn retina_image_local_mapping_keeps_negative_quartz_origin() {
        let rect = PixelRect {
            left: 100,
            top: 40,
            right: 300,
            bottom: 140,
        };
        assert_eq!(
            image_rect_to_quartz(target().quartz_points, (2000, 1000), rect),
            Rect::new(-1390., -180., 100., 50.)
        );
        assert_eq!(
            image_rect_to_quartz(
                target().quartz_points,
                (2000, 1000),
                PixelRect {
                    left: 0,
                    top: 0,
                    right: 2000,
                    bottom: 1000
                }
            ),
            Some(target().quartz_points)
        );
        assert!(image_rect_to_quartz(
            target().quartz_points,
            (2000, 1000),
            PixelRect {
                left: 0,
                top: 0,
                right: 2001,
                bottom: 1000
            }
        )
        .is_none());
        assert!(normalized_rect_to_quartz(target().quartz_points, f64::NAN, 0., 1., 1.).is_none());
    }
    #[test]
    fn exact_launch_window_bounds_and_display_topology_must_remain_bound() {
        let original = target();
        let display = Display::new(
            1,
            Rect::new(-1440., -200., 1440., 900.).unwrap(),
            2880,
            1800,
        )
        .unwrap();
        assert!(same_target(&original, &target(), &[display], &[display]));
        for variant in 0..5 {
            let mut changed = target();
            match variant {
                0 => changed.window_id += 1,
                1 => changed.process.pid += 1,
                2 => changed.process.launch_time_bits += 1,
                3 => changed.process.bundle_id.push('x'),
                _ => changed.quartz_points.x += 1.,
            }
            assert!(!same_target(&original, &changed, &[display], &[display]));
        }
        let mut changed = display;
        changed.pixel_width /= 2;
        assert!(!same_target(&original, &target(), &[display], &[changed]));
        assert!(!same_target(&original, &target(), &[display], &[]));
    }
    #[test]
    fn local_call_optout_is_distinct_from_limited_idle_and_unknown() {
        use call_signals::SignalState::*;
        assert_eq!(
            call_evidence(true, KnownSignalsIdle),
            Evidence::KnownSignalsIdle
        );
        assert_eq!(call_evidence(true, Active), Evidence::Present);
        assert_eq!(call_evidence(true, Unknown), Evidence::Unknown);
        for state in [KnownSignalsIdle, Active, Unknown] {
            assert_eq!(call_evidence(false, state), Evidence::DisabledByLocalPolicy);
        }
    }
    #[test]
    fn monitor_scope_is_supported_by_explicit_monitor_snapshot() {
        let mut config = ScreenConfig::default();
        assert!(allow_scope(&config).is_ok());
        config.privacy.ask_scope = CaptureScope::Monitor;
        assert!(allow_scope(&config).is_ok());
    }
}
