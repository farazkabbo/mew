//! Connecting the desktop app to the user's Mew account for Screen Coach (decision 8).
//!
//! 1. Screen Coach settings → Connect (`screen_coach_link_start`): make a PKCE pair, keep the
//!    verifier here, and open the web app's /desktop/link page with only the challenge.
//! 2. The signed-in page gets a one-time code for the challenge and hands it back
//!    (`screen_coach_link_finish`).
//! 3. Here: redeem code + verifier for a device token, kept in Windows Credential Manager.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use super::coach::{self, require_settings_window, StatusView};
use super::page::require_app_page;
use super::protocol::{is_device_token, is_link_code, ExchangeRequest, IssuedToken};
use super::secret::SecretBytes;
use super::win::{credential, crypto, http, system};

/// How long the web page has to finish a connection started from the settings page.
const LINK_WINDOW: Duration = Duration::from_secs(5 * 60);

/// A connection in progress: the verifier stays here until the page hands over the code.
pub struct PendingLink {
    verifier: SecretBytes,
    started: Instant,
}

/// Starts connecting: opens the web app's link page in the main window.
#[tauri::command]
pub fn screen_coach_link_start<R: Runtime>(window: WebviewWindow<R>) -> Result<StatusView, String> {
    require_settings_window(&window)?;
    let app = window.app_handle();
    let coach = coach::coach_of(app)?;
    let pkce =
        crypto::new_pkce().map_err(|_| "Couldn't start connecting. Try again.".to_owned())?;
    *coach.pending_link() = Some(PendingLink {
        verifier: SecretBytes::from_vec(pkce.verifier.into_bytes()),
        started: Instant::now(),
    });

    let mut url = coach
        .app_url()
        .join("desktop/link")
        .map_err(|_| "The Neb address is invalid.".to_owned())?;
    // In the fragment: the browser never sends it to the server.
    url.set_fragment(Some(&format!("challenge={}", pkce.challenge)));
    let main = app
        .get_webview_window(crate::MAIN)
        .ok_or("The Neb window isn't available.")?;
    main.navigate(url)
        .map_err(|_| "Couldn't open the Neb window.".to_owned())?;
    let _ = main.show();
    let _ = main.unminimize();
    let _ = main.set_focus();
    Ok(coach.view())
}

/// The signed-in page hands over the one-time code; redeem it for a device token.
#[tauri::command(async)]
pub fn screen_coach_link_finish<R: Runtime>(
    window: WebviewWindow<R>,
    code: String,
) -> Result<(), String> {
    let app = window.app_handle();
    let coach = coach::coach_of(app)?;
    require_app_page(&window, coach.app_url())?;
    if !is_link_code(&code) {
        return Err("That code isn't valid.".to_owned());
    }
    let pending = coach
        .pending_link()
        .take()
        .filter(|link| link.started.elapsed() < LINK_WINDOW)
        .ok_or("Start connecting again from Screen Coach settings.")?;
    let verifier = std::str::from_utf8(pending.verifier.as_slice())
        .map_err(|_| "Couldn't connect.".to_owned())?;

    let device_name = system::device_name();
    let body = serde_json::to_vec(&ExchangeRequest {
        code: &code,
        verifier,
        device_name: &device_name,
    })
    .map_err(|_| "Couldn't connect.".to_owned())?;
    let body = SecretBytes::from_vec(body);
    let url = coach
        .app_url()
        .join("api/devices/exchange")
        .map_err(|_| "The Neb address is invalid.".to_owned())?;
    // Sized for the whole reply (it holds the token): growing would leave unwiped copies.
    let mut reply = Vec::with_capacity(4096);
    let status = http::post(
        &url,
        &["Content-Type: application/json".to_owned()],
        body.as_slice(),
        |chunk| reply.extend_from_slice(chunk),
    )
    .map_err(|_| "Couldn't reach Neb. Check your connection and try again.".to_owned())?;
    let reply = SecretBytes::from_vec(reply);
    if status != 200 {
        return Err("Connecting didn't work. Start again from Screen Coach settings.".to_owned());
    }
    let issued: IssuedToken = serde_json::from_slice(reply.as_slice())
        .map_err(|_| "Neb sent an unexpected reply.".to_owned())?;
    let mut token = SecretBytes::from_vec(issued.token.into_bytes());
    let token_text = std::str::from_utf8(token.as_slice()).unwrap_or("");
    if !is_device_token(token_text) {
        return Err("Neb sent an unexpected reply.".to_owned());
    }
    credential::save(token_text)
        .map_err(|_| "Couldn't save the sign-in on this computer.".to_owned())?;
    token.wipe();
    coach.set_connected(true);
    coach::refresh(app);
    Ok(())
}

/// Disconnects: the token is revoked on the server (best effort) and forgotten here.
#[tauri::command(async)]
pub fn screen_coach_disconnect<R: Runtime>(window: WebviewWindow<R>) -> Result<StatusView, String> {
    require_settings_window(&window)?;
    let app = window.app_handle();
    let coach = coach::coach_of(app)?;
    revoke_saved_token(&coach);
    coach.set_connected(false);
    coach::refresh(app);
    Ok(coach.view())
}

/// Revokes the saved token on the server (best effort) and forgets it here. Blocks on the network
/// when there is one.
pub fn revoke_saved_token(coach: &coach::ScreenCoach) {
    if let Some(token) = credential::load() {
        if let (Ok(url), Ok(token)) = (
            coach.app_url().join("api/devices/revoke-self"),
            std::str::from_utf8(token.as_slice()),
        ) {
            let mut headers = [
                "Content-Type: application/json".to_owned(),
                format!("Authorization: Bearer {token}"),
            ];
            let _ = http::post(&url, &headers, b"{}", |_| ());
            headers.iter_mut().for_each(|header| wipe_string(header));
        }
    }
    credential::delete();
}

/// Forgets the sign-in after the server said the token is no longer valid (revoked elsewhere).
pub fn forget_revoked_token<R: Runtime>(app: &AppHandle<R>) {
    credential::delete();
    if let Some(coach) = app.try_state::<coach::ScreenCoach>() {
        coach.set_connected(false);
    }
    coach::refresh(app);
}

/// Zeroes a string that held a secret (zero bytes are valid UTF-8).
pub fn wipe_string(text: &mut str) {
    // SAFETY: writing zero bytes keeps the string valid UTF-8.
    super::secret::wipe(unsafe { text.as_bytes_mut() });
}
