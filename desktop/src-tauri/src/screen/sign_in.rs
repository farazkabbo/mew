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
use super::protocol::{is_device_token, parse_sign_in_link, ExchangeRequest, IssuedSignIn};
use super::secret::SecretBytes;
use super::win::{credential, crypto, http, system};

/// How long the browser has to finish a sign-in started from the login screen.
const SIGN_IN_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Clerk's ticket lasts a minute (the server asks for that); hand it over only well within it.
const TICKET_WINDOW: Duration = Duration::from_secs(50);
/// Tells the login screen that the browser's answer couldn't be used.
const FAILED: &str = "mew:desktop-sign-in-failed";

struct Pending {
    verifier: SecretBytes,
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
    let mut url = coach
        .app_url()
        .join("desktop/authorize")
        .map_err(|_| "The Neb address is invalid.".to_owned())?;
    // In the query, unlike the Connect page's fragment: it has to survive the website's own
    // sign-in redirect. It's only a hash, useless without the verifier that stays here.
    url.query_pairs_mut()
        .append_pair("challenge", &pkce.challenge);
    *app.state::<SignIn>().pending() = Some(Pending {
        verifier: SecretBytes::from_vec(pkce.verifier.into_bytes()),
        started: Instant::now(),
    });
    system::open_web_app_page(&url);
    Ok(url.into())
}

/// A `neb://` link reached the app (the plugin has already matched the scheme, nothing else).
pub fn on_link<R: Runtime>(app: &AppHandle<R>, link: &tauri::Url) {
    crate::show(app);
    let Some(code) = parse_sign_in_link(link) else {
        return;
    };
    let app = app.clone();
    // The exchange is a blocking network call; this runs on the app's main thread.
    tauri::async_runtime::spawn_blocking(move || {
        if finish(&app, &code).is_err() {
            page::dispatch(&app, FAILED, serde_json::Value::Null);
        }
    });
}

/// Why finishing failed doesn't reach the page: it has one message, "try again".
fn finish<R: Runtime>(app: &AppHandle<R>, code: &str) -> Result<(), ()> {
    let sign_in = app.state::<SignIn>();
    let Some(pending) = sign_in
        .pending()
        .take()
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

    let mut token = SecretBytes::from_vec(issued.token.into_bytes());
    let ticket = SecretBytes::from_vec(issued.ticket.into_bytes());
    let token_text = std::str::from_utf8(token.as_slice()).unwrap_or("");
    if !is_device_token(token_text) || ticket.as_slice().is_empty() {
        return Err(());
    }
    // This computer's previous sign-in, perhaps another account's, ends here.
    account::revoke_saved_token(&coach);
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
