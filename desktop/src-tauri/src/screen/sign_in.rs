//! Signing in to the desktop app through the browser (SCREEN_COACH decision 8a).
//!
//! 1. The window's login screen → Continue with browser (`desktop_sign_in_start`): make a PKCE
//!    pair, keep the verifier here, and open the website's /desktop/authorize in the default
//!    browser with only the challenge.
//! 2. The signed-in website sends a one-time code back through a `neb://auth/callback` link.
//! 3. Here: redeem code + verifier for a device token (kept in Windows Credential Manager) and a
//!    one-minute Clerk sign-in ticket.
//! 4. The window opens /desktop/finish, which takes the ticket (`desktop_sign_in_ticket`, once)
//!    and starts the window's own session. The ticket is never in a URL or on disk.
//!
//! Anyone can launch the app with any `neb://` link, so a link proves nothing by itself: a code
//! is only redeemed while a sign-in started here is waiting, and only with its verifier, so
//! someone else's code can't sign this app in to their account.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use super::account;
use super::coach;
use super::page::{self, require_app_page};
use super::protocol::{
    is_device_token, parse_sign_in_link, ExchangeRequest, IssuedSignIn, PollRequest,
};
use super::secret::SecretBytes;
use super::win::{credential, crypto, http, system};

/// How long the browser has to finish a sign-in started from the login screen.
const SIGN_IN_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Clerk's ticket lasts a minute (the server asks for that); hand it over only well within it.
const TICKET_WINDOW: Duration = Duration::from_secs(50);
/// Tells the login screen that the browser's answer couldn't be used.
const FAILED: &str = "mew:desktop-sign-in-failed";
/// The polling fallback (docs/DESKTOP_API.md): every 2 seconds, for up to 3 minutes.
const POLL_EVERY: Duration = Duration::from_secs(2);
const POLL_FOR: Duration = Duration::from_secs(3 * 60);

struct Pending {
    verifier: SecretBytes,
    /// Random, sent with the sign-in and expected back in the neb:// link.
    state: String,
    started: Instant,
}

struct Ticket {
    value: SecretBytes,
    received: Instant,
}

/// What a sign-in in progress holds, in memory only.
#[derive(Default)]
pub struct SignIn {
    pending: Mutex<Option<Pending>>,
    ticket: Mutex<Option<Ticket>>,
}

impl SignIn {
    fn pending(&self) -> std::sync::MutexGuard<'_, Option<Pending>> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn ticket(&self) -> std::sync::MutexGuard<'_, Option<Ticket>> {
        self.ticket
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Starts signing in: opens the website in the default browser. Returns its address, for "Copy
/// the link" if no browser opened.
#[tauri::command]
pub fn desktop_sign_in_start<R: Runtime>(window: WebviewWindow<R>) -> Result<String, String> {
    let app = window.app_handle();
    let coach = coach::coach_of(app)?;
    require_app_page(&window, coach.app_url())?;
    let pkce =
        crypto::new_pkce().map_err(|_| "Couldn't start signing in. Try again.".to_owned())?;
    let state = crate::screen::base64::encode_url_safe(
        &crypto::random_bytes::<16>()
            .map_err(|_| "Couldn't start signing in. Try again.".to_owned())?,
    );
    let mut url = coach
        .app_url()
        .join("desktop/authorize")
        .map_err(|_| "The Neb address is invalid.".to_owned())?;
    // In the query, unlike the Connect page's fragment: it has to survive the website's own
    // sign-in redirect. The challenge is only a hash, useless without the verifier that stays
    // here; the page names the computer by its kind and when this started, never its name.
    let started_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    url.query_pairs_mut()
        .append_pair("challenge", &pkce.challenge)
        .append_pair("state", &state)
        .append_pair("device", "windows")
        .append_pair("at", &started_at.to_string());
    let started = Instant::now();
    *app.state::<SignIn>().pending() = Some(Pending {
        verifier: SecretBytes::from_vec(pkce.verifier.into_bytes()),
        state,
        started,
    });
    system::open_web_app_page(&url);
    poll_in_background(app, started);
    Ok(url.into())
}

/// When the neb:// link doesn't reach the app (blocked, or not registered), polling picks the
/// sign-in up: every 2 seconds for up to 3 minutes, proving itself with the verifier. Whichever
/// arrives first wins; this stops as soon as the sign-in it was started for is no longer waiting.
fn poll_in_background<R: Runtime>(app: &AppHandle<R>, started: Instant) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("neb-sign-in-poll".into())
        .spawn(move || {
            while started.elapsed() < POLL_FOR {
                std::thread::sleep(POLL_EVERY);
                let sign_in = app.state::<SignIn>();
                let verifier = match sign_in.pending().as_ref() {
                    Some(p) if p.started == started => {
                        SecretBytes::from_vec(p.verifier.as_slice().to_vec())
                    }
                    _ => return, // finished by the link, or a newer sign-in started
                };
                let Ok(coach) = coach::coach_of(&app) else {
                    return;
                };
                match poll_once(&coach, &verifier) {
                    Polled::Waiting => {}
                    Polled::Cancelled => {
                        let mut pending = sign_in.pending();
                        if pending.as_ref().is_some_and(|p| p.started == started) {
                            *pending = None;
                        }
                        drop(pending);
                        page::dispatch(&app, FAILED, serde_json::json!({ "reason": "cancelled" }));
                        return;
                    }
                    Polled::Issued(issued) => {
                        let mine = sign_in
                            .pending()
                            .take_if(|p| p.started == started)
                            .is_some();
                        if mine && complete(&app, &coach, issued).is_err() {
                            page::dispatch(&app, FAILED, serde_json::Value::Null);
                        }
                        return;
                    }
                }
            }
        });
}

enum Polled {
    Waiting,
    Cancelled,
    Issued(IssuedSignIn),
}

fn poll_once(coach: &coach::ScreenCoach, verifier: &SecretBytes) -> Polled {
    let Ok(verifier) = std::str::from_utf8(verifier.as_slice()) else {
        return Polled::Waiting;
    };
    let device_name = system::device_name();
    let Ok(body) = serde_json::to_vec(&PollRequest {
        verifier,
        device_name: &device_name,
    }) else {
        return Polled::Waiting;
    };
    let body = SecretBytes::from_vec(body);
    let Ok(url) = coach.app_url().join("api/devices/poll") else {
        return Polled::Waiting;
    };
    let mut reply = Vec::with_capacity(16 * 1024);
    let status = http::post(
        &url,
        &["Content-Type: application/json".to_owned()],
        body.as_slice(),
        |chunk| reply.extend_from_slice(chunk),
    );
    let reply = SecretBytes::from_vec(reply);
    match status {
        Ok(200) => serde_json::from_slice(reply.as_slice()).map_or(Polled::Waiting, Polled::Issued),
        Ok(410) => Polled::Cancelled,
        _ => Polled::Waiting,
    }
}

/// A `neb://` link reached the app (the plugin has already matched the scheme, nothing else).
pub fn on_link<R: Runtime>(app: &AppHandle<R>, link: &tauri::Url) {
    crate::show(app);
    let Some((code, state)) = parse_sign_in_link(link) else {
        return;
    };
    let app = app.clone();
    // The exchange is a blocking network call; this runs on the app's main thread.
    tauri::async_runtime::spawn_blocking(move || {
        if finish(&app, &code, &state).is_err() {
            page::dispatch(&app, FAILED, serde_json::Value::Null);
        }
    });
}

/// Why finishing failed doesn't reach the page: it has one message, "try again".
fn finish<R: Runtime>(app: &AppHandle<R>, code: &str, state: &str) -> Result<(), ()> {
    let sign_in = app.state::<SignIn>();
    // Only a link carrying this sign-in's own state: anything else is a stray or forged link.
    let Some(pending) = sign_in
        .pending()
        .take_if(|pending| pending.state == state)
        .filter(|pending| pending.started.elapsed() < SIGN_IN_WINDOW)
    else {
        // Nothing is waiting (a stray link, or the app restarted): not worth a message.
        return Ok(());
    };
    let coach = coach::coach_of(app).map_err(|_| ())?;
    let issued = redeem(&coach, code, &pending);
    let Ok(issued) = issued else {
        // A stranger's link mustn't cost the student the sign-in they're in the middle of.
        *sign_in.pending() = Some(pending);
        return Err(());
    };
    drop(pending);
    complete(app, &coach, issued)
}

/// Keeps the device token and opens /desktop/finish with the ticket (link or poll alike).
fn complete<R: Runtime>(
    app: &AppHandle<R>,
    coach: &coach::ScreenCoach,
    issued: IssuedSignIn,
) -> Result<(), ()> {
    let sign_in = app.state::<SignIn>();
    let mut token = SecretBytes::from_vec(issued.token.into_bytes());
    let ticket = SecretBytes::from_vec(issued.ticket.into_bytes());
    let token_text = std::str::from_utf8(token.as_slice()).unwrap_or("");
    if !is_device_token(token_text) || ticket.as_slice().is_empty() {
        return Err(());
    }
    // This computer's previous sign-in, perhaps another account's, ends here.
    account::revoke_saved_token(coach);
    credential::save(token_text).map_err(|_| ())?;
    token.wipe();
    coach.set_connected(true);
    coach::refresh(app);

    *sign_in.ticket() = Some(Ticket {
        value: ticket,
        received: Instant::now(),
    });
    let url = coach.app_url().join("desktop/finish").map_err(|_| ())?;
    let window = crate::show(app).ok_or(())?;
    window.navigate(url).map_err(|_| ())
}

fn redeem(coach: &coach::ScreenCoach, code: &str, pending: &Pending) -> Result<IssuedSignIn, ()> {
    let verifier = std::str::from_utf8(pending.verifier.as_slice()).map_err(|_| ())?;
    let device_name = system::device_name();
    let body = serde_json::to_vec(&ExchangeRequest {
        code,
        verifier,
        device_name: &device_name,
    })
    .map_err(|_| ())?;
    let body = SecretBytes::from_vec(body);
    let url = coach
        .app_url()
        .join("api/devices/sign-in")
        .map_err(|_| ())?;
    // Sized for the whole reply (it holds secrets): growing would leave unwiped copies.
    let mut reply = Vec::with_capacity(16 * 1024);
    let status = http::post(
        &url,
        &["Content-Type: application/json".to_owned()],
        body.as_slice(),
        |chunk| reply.extend_from_slice(chunk),
    )
    .map_err(|_| ())?;
    let reply = SecretBytes::from_vec(reply);
    if status != 200 {
        return Err(());
    }
    serde_json::from_slice(reply.as_slice()).map_err(|_| ())
}

/// The ticket for /desktop/finish, once. None if there isn't one (the page was reloaded, say).
#[tauri::command]
pub fn desktop_sign_in_ticket<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<Option<String>, String> {
    let app = window.app_handle();
    let coach = coach::coach_of(app)?;
    require_app_page(&window, coach.app_url())?;
    let ticket = app
        .state::<SignIn>()
        .ticket()
        .take()
        .filter(|ticket| ticket.received.elapsed() < TICKET_WINDOW);
    Ok(ticket.and_then(|ticket| {
        std::str::from_utf8(ticket.value.as_slice())
            .ok()
            .map(str::to_owned)
    }))
}

/// The window has no session (signed out, or it expired), so this computer has no sign-in:
/// Screen Coach's token goes too. Harmless when there is none.
#[tauri::command(async)]
pub fn desktop_sign_out<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    let app = window.app_handle();
    let coach = coach::coach_of(app)?;
    require_app_page(&window, coach.app_url())?;
    account::revoke_saved_token(&coach);
    coach.set_connected(false);
    coach::refresh(app);
    Ok(())
}
