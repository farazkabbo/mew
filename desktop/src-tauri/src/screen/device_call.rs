//! One JSON request to the web app's server with the device token, for the screen features that
//! get a single JSON reply (Watch, what was meant) or a streamed one (typing into a document). The token is read from Credential
//! Manager for the request and wiped from the headers after it.

use std::time::Instant;

use tauri::{AppHandle, Manager, Runtime};

use super::account::{forget_revoked_token, wipe_string};
use super::coach::ScreenCoach;
use super::protocol::limit_message;
use super::win::{credential, http};

/// The largest reply read (a typed passage of 2000 characters as JSON fits many times over).
const MAX_REPLY_BYTES: usize = 32 * 1024;
/// How much of a reply's start is kept, to read a refusal's message from.
const HEAD_BYTES: usize = 4096;

pub const NOT_CONNECTED: &str =
    "Connect Screen Coach to your Neb account first: tray → Settings on this PC → Connect.";
pub const SIGNED_OUT: &str =
    "Screen Coach was signed out of your Neb account. Connect again in Settings on this PC.";

/// Why a request didn't give a reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallError {
    /// Not connected, or signed out (the token was forgotten): the message says so.
    Account(String),
    /// A limit, with the server's own words (rate, allowance, capacity, unverified email).
    Limited(String),
    /// Too many requests (429 without a known message).
    Busy,
    /// The network, the server or the model: try again later.
    Failed,
}

/// POSTs `body` to `path` (`label` names it in the log; never what's in it). The reply's bytes
/// on a 200.
pub fn post<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    label: &str,
    body: &[u8],
) -> Result<Vec<u8>, CallError> {
    let mut reply = Vec::new();
    let mut too_large = false;
    post_stream(app, path, label, body, |chunk| {
        if reply.len() + chunk.len() > MAX_REPLY_BYTES {
            too_large = true;
        } else {
            reply.extend_from_slice(chunk);
        }
    })?;
    if too_large {
        return Err(CallError::Failed);
    }
    Ok(reply)
}

/// POSTs `body` to `path` and passes the reply's bytes to `on_chunk` as they arrive (whatever
/// the status turns out to be: a refusal's body is JSON the caller's parser won't take for a
/// reply). Ok on a 200, once the reply has ended.
pub fn post_stream<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    label: &str,
    body: &[u8],
    on_chunk: impl FnMut(&[u8]),
) -> Result<(), CallError> {
    send(app, path, label, body, "application/json", on_chunk)
}

/// POSTs raw bytes (`content_type`, e.g. a handoff's ciphertext) and returns the reply's bytes.
pub fn post_bytes<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    label: &str,
    body: &[u8],
    content_type: &str,
    max_reply: usize,
) -> Result<Vec<u8>, CallError> {
    let mut reply = Vec::new();
    let mut too_large = false;
    send(app, path, label, body, content_type, |chunk| {
        if reply.len() + chunk.len() > max_reply {
            too_large = true;
        } else {
            reply.extend_from_slice(chunk);
        }
    })?;
    if too_large {
        return Err(CallError::Failed);
    }
    Ok(reply)
}

fn send<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    label: &str,
    body: &[u8],
    content_type: &str,
    mut on_chunk: impl FnMut(&[u8]),
) -> Result<(), CallError> {
    let coach = app.try_state::<ScreenCoach>().ok_or(CallError::Failed)?;
    let token = credential::load().ok_or_else(|| CallError::Account(NOT_CONNECTED.into()))?;
    let token = std::str::from_utf8(token.as_slice())
        .map_err(|_| CallError::Account(NOT_CONNECTED.into()))?;
    let url = coach.app_url().join(path).map_err(|_| CallError::Failed)?;
    let mut headers = [
        format!("Content-Type: {content_type}"),
        "Accept: application/json, application/x-ndjson, application/octet-stream".to_owned(),
        format!("Authorization: Bearer {token}"),
    ];

    let started = Instant::now();
    // The start of the body, for a refusal's own words (a limit's message).
    let mut head = Vec::new();
    let result = http::post(&url, &headers, body, |chunk| {
        if head.len() < HEAD_BYTES {
            head.extend_from_slice(&chunk[..chunk.len().min(HEAD_BYTES - head.len())]);
        }
        on_chunk(chunk);
    });
    headers.iter_mut().for_each(|header| wipe_string(header));
    let status = result.map_err(|_| CallError::Failed)?;
    // Timings and statuses only: never what was sent or answered.
    eprintln!(
        "[screen] {label}: status {status} in {} ms",
        started.elapsed().as_millis()
    );
    if status == 200 {
        return Ok(());
    }
    if let Some(message) = limit_message(&head) {
        return Err(CallError::Limited(message));
    }
    match status {
        401 => {
            forget_revoked_token(app);
            Err(CallError::Account(SIGNED_OUT.into()))
        }
        429 => Err(CallError::Busy),
        _ => Err(CallError::Failed),
    }
}
