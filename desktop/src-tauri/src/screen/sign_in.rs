//! Native browser sign-in on Windows and macOS. The browser gets a PKCE challenge and a random
//! state. Only this process holds its verifier, and only the scoped main webview can take the
//! one-use Clerk ticket. The device credential stays in the OS credential store.

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, Runtime, Url, WebviewWindow};

use super::base64::encode_url_safe;
#[cfg(target_os = "macos")]
use super::mac_auth as platform;
use super::page::{self, require_app_page};
use super::protocol::{
    is_device_token, parse_sign_in_link, ExchangeRequest, IssuedSignIn, PollRequest,
};
use super::secret::SecretBytes;
#[cfg(windows)]
use super::win::auth as platform;

/// How long the browser has to finish a sign-in started from the login screen.
const SIGN_IN_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Clerk's ticket lasts a minute. Only pass on a fresh ticket, and only once.
const TICKET_WINDOW: Duration = Duration::from_secs(50);
const FAILED: &str = "mew:desktop-sign-in-failed";
const POLL_EVERY: Duration = Duration::from_secs(2);
const POLL_FOR: Duration = Duration::from_secs(3 * 60);
pub(super) const MAX_REPLY_BYTES: usize = 16 * 1024;

struct Pending {
    verifier: SecretBytes,
    state: String,
    started: Instant,
    exchanging: bool,
}

struct Ticket {
    started: Instant,
    token: SecretBytes,
    value: SecretBytes,
    received: Instant,
}

#[derive(Default)]
struct Attempt {
    pending: Option<Pending>,
    ticket: Option<Ticket>,
    last_started: Option<Instant>,
    saved_by: Option<Instant>,
}

impl Attempt {
    fn begin(&mut self, pending: Pending) -> Option<Ticket> {
        self.last_started = Some(pending.started);
        self.pending = Some(pending);
        self.ticket.take()
    }

    fn matching(&mut self, started: Instant) -> Option<&mut Pending> {
        self.pending
            .as_mut()
            .filter(|pending| pending.started == started && started.elapsed() < SIGN_IN_WINDOW)
    }

    fn cancel_before(&mut self, requested_at: Instant) -> Option<Ticket> {
        if self
            .last_started
            .is_some_and(|started| started <= requested_at)
        {
            self.cancel()
        } else {
            None
        }
    }

    fn cancel(&mut self) -> Option<Ticket> {
        self.last_started = None;
        self.pending = None;
        self.ticket.take()
    }

    fn claim(&mut self, started: Instant) -> Option<Ticket> {
        self.ticket.take_if(|ticket| ticket.started == started)
    }

    fn expire(&mut self, started: Instant) -> bool {
        started.elapsed() >= SIGN_IN_WINDOW
            && self
                .pending
                .take_if(|pending| pending.started == started)
                .is_some()
    }
}

pub struct SignIn {
    app_url: Url,
    attempt: Mutex<Attempt>,
    #[cfg(target_os = "macos")]
    presence: std::sync::atomic::AtomicU64,
}

impl SignIn {
    #[cfg(target_os = "macos")]
    pub(crate) fn app_url(&self) -> &Url {
        &self.app_url
    }

    pub fn new(app_url: Url) -> Self {
        Self {
            app_url,
            attempt: Mutex::default(),
            #[cfg(target_os = "macos")]
            presence: std::sync::atomic::AtomicU64::new(0),
        }
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn known_connected(&self) -> Option<bool> {
        match self.presence_snapshot() & 3 {
            1 => Some(false),
            2 => Some(true),
            _ => None,
        }
    }
    #[cfg(target_os = "macos")]
    pub(crate) fn presence_snapshot(&self) -> u64 {
        self.presence.load(std::sync::atomic::Ordering::Acquire)
    }
    #[cfg(target_os = "macos")]
    pub(crate) fn observe_presence(&self, observed: u64, present: bool) {
        let next = (observed & !3) | if present { 2 } else { 1 };
        let _ = self.presence.compare_exchange(
            observed,
            next,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        );
    }
    #[cfg(target_os = "macos")]
    fn cache_connected(&self, present: bool) {
        let _ = self.presence.fetch_update(
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
            |old| Some((old.wrapping_add(4) & !3) | if present { 2 } else { 1 }),
        );
    }

    fn attempt(&self) -> MutexGuard<'_, Attempt> {
        self.attempt
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// A late 401 may only remove the credential that actually made that request. This uses
/// the same account lock as ticket replacement and sign-out, including the Keychain check.
#[cfg(target_os = "macos")]
pub(crate) fn forget_rejected_token<R: Runtime>(
    app: &AppHandle<R>,
    expected: &[u8],
) -> Result<bool, ()> {
    let sign_in = app.try_state::<SignIn>().ok_or(())?;
    let mut attempt = sign_in.attempt();
    let removed = remove_matching_token(
        expected,
        || platform::load_token(&sign_in.app_url),
        || platform::delete_token(&sign_in.app_url),
    )?;
    if removed {
        attempt.saved_by = None;
        set_connected(app, false);
    }
    Ok(removed)
}

#[cfg(any(target_os = "macos", test))]
fn remove_matching_token(
    expected: &[u8],
    load: impl FnOnce() -> Result<Option<SecretBytes>, ()>,
    delete: impl FnOnce() -> Result<(), ()>,
) -> Result<bool, ()> {
    if load()?.is_some_and(|current| current.as_slice() == expected) {
        delete()?;
        Ok(true)
    } else {
        Ok(false)
    }
}

pub(super) fn allows_auth_transport(url: &Url) -> bool {
    url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && (url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
}

fn app_endpoint(app_url: &Url, path: &str) -> Result<Url, ()> {
    if !allows_auth_transport(app_url) {
        return Err(());
    }
    let target = app_url.join(path).map_err(|_| ())?;
    (target.origin() == app_url.origin() && allows_auth_transport(&target))
        .then_some(target)
        .ok_or(())
}

fn new_attempt() -> Result<(Pending, String), String> {
    let error = |_| "Couldn't start signing in. Try again.".to_owned();
    let verifier = SecretBytes::from_vec(
        encode_url_safe(&platform::random_bytes::<32>().map_err(error)?).into_bytes(),
    );
    let digest = platform::sha256(verifier.as_slice())
        .map_err(|_| "Couldn't start signing in. Try again.".to_owned())?;
    let state = encode_url_safe(&platform::random_bytes::<16>().map_err(error)?);
    Ok((
        Pending {
            verifier,
            state,
            started: Instant::now(),
            exchanging: false,
        },
        encode_url_safe(&digest),
    ))
}

/// Opens the default browser and returns the URL for "Copy the link".
#[tauri::command]
pub fn desktop_sign_in_start<R: Runtime>(window: WebviewWindow<R>) -> Result<String, String> {
    let app = window.app_handle();
    let sign_in = app.state::<SignIn>();
    require_app_page(&window, &sign_in.app_url)?;
    let mut url = app_endpoint(&sign_in.app_url, "desktop/authorize")
        .map_err(|_| "The Neb address is invalid.".to_owned())?;
    let (pending, challenge) = new_attempt()?;
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    url.query_pairs_mut()
        .append_pair("challenge", &challenge)
        .append_pair("state", &pending.state)
        .append_pair("device", platform::DEVICE)
        .append_pair("at", &started_at.to_string());
    let started = pending.started;
    let previous = sign_in.attempt().begin(pending);
    if let Some(previous) = previous {
        revoke_in_background(app, previous.token);
    }
    platform::open_auth_page(&url);
    poll_in_background(app, started);
    Ok(url.into())
}

/// Polling recovers when the neb:// link does not reach the running process. An attempt can
/// still receive its deep link after polling stops, up to SIGN_IN_WINDOW.
fn poll_in_background<R: Runtime>(app: &AppHandle<R>, started: Instant) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("neb-sign-in-poll".into())
        .spawn(move || {
            let sign_in = app.state::<SignIn>();
            loop {
                std::thread::sleep(
                    POLL_EVERY.min(SIGN_IN_WINDOW.saturating_sub(started.elapsed())),
                );
                let verifier = {
                    let mut attempt = sign_in.attempt();
                    if started.elapsed() >= SIGN_IN_WINDOW {
                        let expired = attempt.expire(started);
                        drop(attempt);
                        if expired {
                            dispatch_failure(&app, started, serde_json::Value::Null);
                        }
                        return;
                    }
                    let Some(pending) = attempt.pending.as_ref().filter(|p| p.started == started)
                    else {
                        return;
                    };
                    if pending.exchanging || started.elapsed() >= POLL_FOR {
                        continue;
                    }
                    SecretBytes::from_vec(pending.verifier.as_slice().to_vec())
                };
                let Ok(verifier) = std::str::from_utf8(verifier.as_slice()) else {
                    return;
                };
                let device_name = platform::device_name();
                let request = PollRequest {
                    verifier,
                    device_name: &device_name,
                };
                match request_sign_in(&sign_in.app_url, "api/devices/poll", &request) {
                    Ok((200, body)) => {
                        if let Ok(issued) = serde_json::from_slice(body.as_slice()) {
                            if complete(&app, started, issued).is_err() {
                                dispatch_failure(&app, started, serde_json::Value::Null);
                            }
                            return;
                        }
                    }
                    Ok((410, _)) => {
                        let mut attempt = sign_in.attempt();
                        if attempt.matching(started).is_some() {
                            attempt.pending = None;
                            drop(attempt);
                            dispatch_failure(
                                &app,
                                started,
                                serde_json::json!({"reason": "cancelled"}),
                            );
                        }
                        return;
                    }
                    _ => {}
                }
            }
        });
}

/// A warm callback. A cold start has no pending attempt and cannot redeem any link.
pub fn on_link<R: Runtime>(app: &AppHandle<R>, link: &Url) {
    let Some((code, state)) = parse_sign_in_link(link) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        finish(&app, &code, &state);
    });
}

fn finish<R: Runtime>(app: &AppHandle<R>, code: &str, state: &str) {
    let sign_in = app.state::<SignIn>();
    let (started, verifier) = {
        let mut attempt = sign_in.attempt();
        let Some(pending) = attempt.pending.as_mut().filter(|pending| {
            pending.state == state
                && !pending.exchanging
                && pending.started.elapsed() < SIGN_IN_WINDOW
        }) else {
            return;
        };
        pending.exchanging = true;
        (
            pending.started,
            SecretBytes::from_vec(pending.verifier.as_slice().to_vec()),
        )
    };
    let verifier = std::str::from_utf8(verifier.as_slice()).unwrap_or_default();
    let device_name = platform::device_name();
    let request = ExchangeRequest {
        code,
        verifier,
        device_name: &device_name,
    };
    let issued = request_sign_in(&sign_in.app_url, "api/devices/sign-in", &request)
        .ok()
        .filter(|(status, _)| *status == 200)
        .and_then(|(_, body)| serde_json::from_slice(body.as_slice()).ok());
    if let Some(issued) = issued {
        if complete(app, started, issued).is_err() {
            dispatch_failure(app, started, serde_json::Value::Null);
        }
    } else {
        // Keep polling after a failed exchange. A late failure cannot restore an old attempt.
        let mut attempt = sign_in.attempt();
        if let Some(pending) = attempt.matching(started) {
            pending.exchanging = false;
            // A poll may have consumed this code and be returning the same sign-in.
            if started.elapsed() >= POLL_FOR {
                drop(attempt);
                dispatch_failure(app, started, serde_json::Value::Null);
            }
        }
    }
}

fn dispatch_failure<R: Runtime>(app: &AppHandle<R>, started: Instant, detail: serde_json::Value) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let sign_in = handle.state::<SignIn>();
        let attempt = sign_in.attempt();
        if attempt.last_started == Some(started) && attempt.ticket.is_none() {
            page::dispatch(&handle, FAILED, detail);
        }
    });
}

fn request_sign_in(
    app_url: &Url,
    path: &str,
    request: &impl serde::Serialize,
) -> Result<(u16, SecretBytes), ()> {
    let url = app_endpoint(app_url, path)?;
    let body = SecretBytes::from_vec(serde_json::to_vec(request).map_err(|_| ())?);
    let mut reply = Vec::with_capacity(MAX_REPLY_BYTES);
    let mut overflow = false;
    let status = platform::post(app_url, &url, body.as_slice(), None, |chunk| {
        if chunk.len() <= MAX_REPLY_BYTES - reply.len() && !overflow {
            reply.extend_from_slice(chunk);
        } else {
            overflow = true;
        }
    });
    let reply = SecretBytes::from_vec(reply);
    Ok((status?, (!overflow).then_some(reply).ok_or(())?))
}

fn revoke_token(app_url: &Url, token: &SecretBytes) {
    if let (Ok(url), Ok(token)) = (
        app_endpoint(app_url, "api/devices/revoke-self"),
        std::str::from_utf8(token.as_slice()),
    ) {
        let _ = platform::post(app_url, &url, b"{}", Some(token), |_| ());
    }
}

fn set_connected<R: Runtime>(app: &AppHandle<R>, connected: bool) {
    #[cfg(windows)]
    {
        if let Some(coach) = app.try_state::<super::coach::ScreenCoach>() {
            coach.set_connected(connected);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(sign) = app.try_state::<SignIn>() {
            sign.cache_connected(connected);
        }
        super::mac::runtime::account_changed(app);
    }
}

/// Stage both secrets in memory. Keep any prior completed sign-in until the finish page
/// claims the ticket and the OS credential store accepts its replacement.
fn complete<R: Runtime>(
    app: &AppHandle<R>,
    started: Instant,
    issued: IssuedSignIn,
) -> Result<(), ()> {
    let received = Instant::now();
    let ticket = Ticket {
        started,
        token: SecretBytes::from_vec(issued.token.into_bytes()),
        value: SecretBytes::from_vec(issued.ticket.into_bytes()),
        received,
    };
    let token_text = std::str::from_utf8(ticket.token.as_slice()).map_err(|_| ())?;
    if !is_device_token(token_text) {
        return Err(());
    }
    let sign_in = app.state::<SignIn>();
    let app_url = &sign_in.app_url;
    let finish_url = app_endpoint(app_url, "desktop/finish")?;
    let mut attempt = sign_in.attempt();
    if attempt.matching(started).is_none() {
        drop(attempt);
        revoke_token(app_url, &ticket.token);
        return Ok(());
    }
    attempt.pending = None;
    if ticket.value.is_empty() {
        drop(attempt);
        revoke_token(app_url, &ticket.token);
        return Err(());
    }
    attempt.ticket = Some(ticket);
    drop(attempt);
    let handle = app.clone();
    if app
        .run_on_main_thread(move || {
            let sign_in = handle.state::<SignIn>();
            let mut attempt = sign_in.attempt();
            if attempt.last_started != Some(started) {
                return;
            }
            if let Some(ticket) = attempt.ticket.as_ref() {
                let navigated = ticket.received.elapsed() < TICKET_WINDOW
                    && crate::show(&handle)
                        .is_some_and(|window| window.navigate(finish_url).is_ok());
                if !navigated {
                    let abandoned = attempt.ticket.take();
                    page::dispatch(&handle, FAILED, serde_json::Value::Null);
                    drop(attempt);
                    if let Some(abandoned) = abandoned {
                        revoke_in_background(&handle, abandoned.token);
                    }
                }
            }
        })
        .is_err()
    {
        let abandoned = sign_in
            .attempt()
            .ticket
            .take_if(|ticket| ticket.started == started);
        if let Some(abandoned) = abandoned {
            revoke_token(app_url, &abandoned.token);
        }
        return Err(());
    }
    Ok(())
}

/// Only the matching app's main window on the finish page can take the ticket, once.
#[tauri::command]
pub async fn desktop_sign_in_ticket<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<Option<String>, String> {
    let app = window.app_handle().clone();
    let sign_in = app.state::<SignIn>();
    let finish_url = app_endpoint(&sign_in.app_url, "desktop/finish")
        .map_err(|_| "The Neb address is invalid.".to_owned())?;
    if window.label() != crate::MAIN
        || !window
            .url()
            .is_ok_and(|url| url.origin() == finish_url.origin() && url.path() == finish_url.path())
    {
        return Err("Not allowed.".to_owned());
    }
    let started = sign_in
        .attempt()
        .ticket
        .as_ref()
        .map(|ticket| ticket.started);
    let Some(started) = started else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || claim_ticket(&app, started))
        .await
        .map_err(|_| "Couldn't finish signing in.".to_owned())?
}

fn claim_ticket<R: Runtime>(
    app: &AppHandle<R>,
    started: Instant,
) -> Result<Option<String>, String> {
    let sign_in = app.state::<SignIn>();
    let app_url = &sign_in.app_url;
    let mut attempt = sign_in.attempt();
    let Some(ticket) = attempt.claim(started) else {
        return Ok(None);
    };
    let token_text = std::str::from_utf8(ticket.token.as_slice())
        .map_err(|_| "Couldn't finish signing in.".to_owned())?;
    let previous = platform::load_token(app_url).and_then(|previous| {
        if ticket.received.elapsed() >= TICKET_WINDOW {
            return Err(());
        }
        platform::save_token(app_url, token_text)?;
        if ticket.received.elapsed() >= TICKET_WINDOW {
            // An OS credential prompt can outlive the server ticket. Restore the previous
            // credential if possible, and revoke the unused one before reporting the failure.
            let restored = previous
                .as_ref()
                .and_then(|previous| std::str::from_utf8(previous.as_slice()).ok())
                .is_some_and(|previous| platform::save_token(app_url, previous).is_ok());
            if !restored {
                let _ = platform::delete_token(app_url);
                attempt.saved_by = None;
                set_connected(app, false);
            }
            return Err(());
        }
        Ok(previous)
    });
    let Ok(previous) = previous else {
        drop(attempt);
        revoke_in_background(app, ticket.token);
        return Err("Couldn't finish signing in.".to_owned());
    };
    attempt.saved_by = Some(ticket.started);
    set_connected(app, true);
    drop(attempt);
    #[cfg(windows)]
    super::coach::refresh(app);
    if let Some(previous) =
        previous.filter(|previous| previous.as_slice() != ticket.token.as_slice())
    {
        revoke_in_background(app, previous);
    }
    Ok(std::str::from_utf8(ticket.value.as_slice())
        .ok()
        .map(str::to_owned))
}

/// Cancels the current handoff while leaving any prior completed session alone.
#[tauri::command]
pub fn desktop_sign_in_cancel<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    let app = window.app_handle();
    let sign_in = app.state::<SignIn>();
    require_app_page(&window, &sign_in.app_url)?;
    let abandoned = sign_in.attempt().cancel();
    if let Some(abandoned) = abandoned {
        revoke_in_background(app, abandoned.token);
    }
    Ok(())
}

fn revoke_in_background<R: Runtime>(app: &AppHandle<R>, token: SecretBytes) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sign_in = app.state::<SignIn>();
        revoke_token(&sign_in.app_url, &token);
    });
}

fn disconnect<R: Runtime>(
    app: &AppHandle<R>,
    should_disconnect: impl FnOnce(&Attempt) -> bool,
) -> Result<(), String> {
    let sign_in = app.state::<SignIn>();
    let app_url = &sign_in.app_url;
    let error = |_| "Couldn't remove this device's sign-in.".to_owned();
    let token = {
        let mut attempt = sign_in.attempt();
        if !should_disconnect(&attempt) {
            return Ok(());
        }
        let token = platform::load_token(app_url).map_err(error)?;
        platform::delete_token(app_url).map_err(error)?;
        attempt.saved_by = None;
        set_connected(app, false);
        token
    };
    #[cfg(windows)]
    super::coach::refresh(app);
    if let Some(token) = token {
        revoke_token(app_url, &token);
    }
    Ok(())
}

/// Ends the saved device sign-in when the webview's separate session ends.
#[tauri::command]
pub async fn desktop_sign_out<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    let requested_at = Instant::now();
    let app = window.app_handle().clone();
    let sign_in = app.state::<SignIn>();
    require_app_page(&window, &sign_in.app_url)?;
    let abandoned = sign_in.attempt().cancel_before(requested_at);
    if let Some(abandoned) = abandoned {
        revoke_in_background(&app, abandoned.token);
    }
    tauri::async_runtime::spawn_blocking(move || {
        // This worker may run after a later browser sign-in has already finished.
        disconnect(&app, |attempt| {
            attempt
                .saved_by
                .is_none_or(|started| started <= requested_at)
        })
    })
    .await
    .map_err(|_| "Couldn't sign out of this device.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revoked_request_cannot_erase_a_replaced_or_missing_credential() {
        use std::cell::Cell;
        let deleted = Cell::new(false);
        for current in [Some(b"new-token".as_slice()), None] {
            assert!(!remove_matching_token(
                b"old-token",
                || Ok(current.map(|bytes| SecretBytes::from_vec(bytes.to_vec()))),
                || {
                    deleted.set(true);
                    Ok(())
                }
            )
            .unwrap());
            assert!(!deleted.get());
        }
        assert!(remove_matching_token(
            b"old-token",
            || Ok(Some(SecretBytes::from_vec(b"old-token".to_vec()))),
            || {
                deleted.set(true);
                Ok(())
            }
        )
        .unwrap());
        assert!(deleted.get());
        assert_eq!(
            remove_matching_token(
                b"old-token",
                || Err(()),
                || panic!("failed load must not erase")
            ),
            Err(())
        );
        assert_eq!(
            remove_matching_token(
                b"old-token",
                || Ok(Some(SecretBytes::from_vec(b"old-token".to_vec()))),
                || Err(())
            ),
            Err(())
        );
    }

    #[test]
    fn allows_only_same_origin_https_and_local_http() {
        let join = |origin, endpoint| app_endpoint(&Url::parse(origin).unwrap(), endpoint);
        assert!(join("https://neb.test", "/api/devices/poll").is_ok());
        assert!(join("http://localhost:3000", "/api/devices/poll").is_ok());
        assert!(join("http://127.0.0.1:3000", "/api/devices/poll").is_ok());
        assert!(join("http://[::1]:3000", "/api/devices/poll").is_ok());
        assert!(join("http://neb.test", "/api/devices/poll").is_err());
        assert!(join("https://name:password@neb.test", "/api/devices/poll").is_err());
        assert!(join(
            "https://neb.test",
            "https://elsewhere.test/api/devices/poll"
        )
        .is_err());
    }

    #[test]
    fn retry_supersedes_pending_attempt_and_discards_ticket() {
        let (a, _) = new_attempt().unwrap();
        let started = a.started;
        let (mut b, _) = new_attempt().unwrap();
        b.started = started + Duration::from_nanos(1);
        let mut attempt = Attempt::default();
        assert!(attempt.begin(a).is_none());
        attempt.ticket = Some(Ticket {
            started,
            token: SecretBytes::from_vec(b"synthetic-token".to_vec()),
            value: SecretBytes::from_vec(b"synthetic-ticket".to_vec()),
            received: Instant::now(),
        });
        assert_eq!(attempt.begin(b).map(|ticket| ticket.started), Some(started));
        assert!(attempt.matching(started).is_none());
        assert!(attempt.ticket.take().is_none());
    }

    #[test]
    fn sign_out_invalidates_an_in_flight_exchange_but_preserves_a_later_attempt() {
        let (pending, _) = new_attempt().unwrap();
        let started = pending.started;
        let sign_out_at = started + Duration::from_nanos(1);
        let mut attempt = Attempt::default();
        assert!(attempt.begin(pending).is_none());
        attempt.matching(started).unwrap().exchanging = true;

        assert!(attempt.cancel_before(sign_out_at).is_none());
        assert!(attempt.matching(started).is_none());
        assert!(attempt.last_started.is_none());
        assert!(attempt.ticket.take().is_none());

        let (mut next, _) = new_attempt().unwrap();
        let next_started = sign_out_at + Duration::from_nanos(1);
        next.started = next_started;
        assert!(attempt.begin(next).is_none());
        assert!(attempt.cancel_before(sign_out_at).is_none());
        assert!(attempt.matching(next_started).is_some());
    }

    #[test]
    fn cancel_invalidates_an_exchange_and_clears_only_a_staged_ticket() {
        let (pending, _) = new_attempt().unwrap();
        let started = pending.started;
        let mut attempt = Attempt::default();
        assert!(attempt.begin(pending).is_none());
        assert!(attempt.cancel().is_none());
        assert!(attempt.matching(started).is_none());

        attempt.last_started = Some(started);
        attempt.saved_by = Some(started);
        attempt.ticket = Some(Ticket {
            started,
            token: SecretBytes::from_vec(b"synthetic-token".to_vec()),
            value: SecretBytes::from_vec(b"synthetic-ticket".to_vec()),
            received: Instant::now(),
        });
        assert_eq!(attempt.cancel().map(|ticket| ticket.started), Some(started));
        assert_eq!(attempt.saved_by, Some(started));
        assert!(attempt.ticket.take().is_none());
        assert!(attempt.cancel().is_none());
    }
    #[test]
    fn delayed_finish_cannot_claim_a_later_ticket() {
        let previous = Instant::now();
        let started = previous + Duration::from_nanos(1);
        let mut attempt = Attempt {
            ticket: Some(Ticket {
                started,
                token: SecretBytes::from_vec(b"synthetic-token".to_vec()),
                value: SecretBytes::from_vec(b"synthetic-ticket".to_vec()),
                received: Instant::now(),
            }),
            ..Attempt::default()
        };
        assert!(attempt.claim(previous).is_none());
        assert_eq!(
            attempt.claim(started).unwrap().value.as_slice(),
            b"synthetic-ticket",
        );
        assert!(attempt.claim(started).is_none());
    }

    #[test]
    fn expires_only_the_matching_pending_attempt_after_the_full_window() {
        let (mut pending, _) = new_attempt().unwrap();
        let grace_period = Instant::now() - POLL_FOR;
        pending.started = grace_period;
        let mut attempt = Attempt::default();
        assert!(attempt.begin(pending).is_none());
        assert!(!attempt.expire(grace_period));
        assert!(!attempt.expire(grace_period - SIGN_IN_WINDOW));
        assert!(attempt.matching(grace_period).is_some());

        let (mut pending, _) = new_attempt().unwrap();
        let expired = Instant::now() - SIGN_IN_WINDOW;
        pending.started = expired;
        assert!(attempt.begin(pending).is_none());
        assert!(attempt.expire(expired));
        assert!(attempt.pending.is_none());
    }
}

#[cfg(all(test, target_os = "macos"))]
mod cached_presence_tests {
    use super::*;
    #[test]
    fn stale_native_observations_never_override_signout() {
        let sign = SignIn::new(Url::parse("https://example.invalid").unwrap());
        assert_eq!(sign.known_connected(), None);
        let observed = sign.presence_snapshot();
        sign.observe_presence(observed, true);
        assert_eq!(sign.known_connected(), Some(true));
        let old = sign.presence_snapshot();
        sign.cache_connected(false);
        sign.observe_presence(old, true);
        assert_eq!(sign.known_connected(), Some(false));
    }
}
