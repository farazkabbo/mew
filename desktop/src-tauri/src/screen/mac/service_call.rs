//! Bounded native device transport. Call on a worker; credentials and response bytes never
//! cross webview IPC. Uses the browser sign-in's origin-scoped Keychain credential.
use crate::screen::{
    mac_auth,
    protocol::{is_uuid, limit_message},
    secret::{wipe, SecretBytes},
    sign_in::{self, SignIn},
};
use reqwest::{
    blocking::{Body, Client},
    header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE},
};
use sha2::{Digest, Sha256};
use std::{fmt, io::Read, sync::OnceLock, time::Duration};
use tauri::{AppHandle, Manager, Runtime, Url};

const JSON_LIMIT: usize = 256 * 1024;
const STREAM_LIMIT: usize = 1024 * 1024;
const BINARY_LIMIT: usize = 64 * 1024 * 1024;
const HEAD_LIMIT: usize = 4096;
pub const NOT_CONNECTED: &str = "Connect Screen Coach to your Neb account first.";
pub const SIGNED_OUT: &str = "Screen Coach was signed out of your Neb account. Connect again.";

/// Native-only binding for explicit saved drafts; never sent over IPC or persisted.
pub fn credential_stamp<R: Runtime>(app: &AppHandle<R>) -> Result<[u8; 32], CallError> {
    let account = app.try_state::<SignIn>().ok_or(CallError::Failed)?;
    let observed = account.presence_snapshot();
    let token = mac_auth::load_token(account.app_url()).map_err(|_| CallError::Failed)?;
    account.observe_presence(observed, token.is_some());
    let token = token.ok_or_else(|| CallError::Account(NOT_CONNECTED.into()))?;
    Ok(Sha256::digest(token.as_slice()).into())
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallError {
    Account(String),
    Limited(String),
    Busy,
    Failed,
    Cancelled,
}
impl fmt::Display for CallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Account(s) | Self::Limited(s) => s,
            Self::Busy => "Neb is busy. Try again shortly.",
            Self::Failed => "Couldn't reach Neb. Try again.",
            Self::Cancelled => "Cancelled.",
        })
    }
}

pub fn post<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    label: &str,
    body: &[u8],
    cancelled: &dyn Fn() -> bool,
) -> Result<SecretBytes, CallError> {
    post_bytes(
        app,
        path,
        label,
        body,
        "application/json",
        JSON_LIMIT,
        cancelled,
    )
}

/// Commit an explicit draft using exactly the credential it was previewed under.
pub fn post_bound<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    body: &[u8],
    stamp: &[u8; 32],
    cancelled: &dyn Fn() -> bool,
) -> Result<SecretBytes, CallError> {
    let mut reply = SecretBytes::zeroed(JSON_LIMIT);
    let mut used = 0;
    call(
        app,
        path,
        "draft",
        body,
        "application/json",
        JSON_LIMIT,
        cancelled,
        Some(stamp),
        |chunk| {
            reply.as_mut_slice()[used..used + chunk.len()].copy_from_slice(chunk);
            used += chunk.len();
        },
    )?;
    check(cancelled)?;
    reply.truncate(used);
    Ok(reply)
}
pub fn post_bytes<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    label: &str,
    body: &[u8],
    content_type: &str,
    max_reply: usize,
    cancelled: &dyn Fn() -> bool,
) -> Result<SecretBytes, CallError> {
    post_bytes_inner(
        app,
        path,
        label,
        body,
        content_type,
        max_reply,
        cancelled,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn post_bytes_bound<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    body: &[u8],
    content_type: &str,
    max_reply: usize,
    stamp: &[u8; 32],
    cancelled: &dyn Fn() -> bool,
) -> Result<SecretBytes, CallError> {
    post_bytes_inner(
        app,
        path,
        "draft",
        body,
        content_type,
        max_reply,
        cancelled,
        Some(stamp),
    )
}

#[allow(clippy::too_many_arguments)]
fn post_bytes_inner<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    label: &str,
    body: &[u8],
    content_type: &str,
    max_reply: usize,
    cancelled: &dyn Fn() -> bool,
    stamp: Option<&[u8; 32]>,
) -> Result<SecretBytes, CallError> {
    if max_reply == 0 || max_reply > BINARY_LIMIT {
        return Err(CallError::Failed);
    }
    // One allocation: SecretBytes wipes unused capacity and all refusal/error bytes.
    let mut reply = SecretBytes::zeroed(max_reply);
    let mut used = 0;
    call(
        app,
        path,
        label,
        body,
        content_type,
        max_reply,
        cancelled,
        stamp,
        |chunk| {
            reply.as_mut_slice()[used..used + chunk.len()].copy_from_slice(chunk);
            used += chunk.len();
        },
    )?;
    check(cancelled)?;
    reply.truncate(used);
    Ok(reply)
}
pub fn post_stream<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    label: &str,
    body: &[u8],
    cancelled: &dyn Fn() -> bool,
    on_chunk: impl FnMut(&[u8]),
) -> Result<(), CallError> {
    call(
        app,
        path,
        label,
        body,
        "application/json",
        STREAM_LIMIT,
        cancelled,
        None,
        on_chunk,
    )
}

pub fn post_stream_bound<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    body: &[u8],
    stamp: &[u8; 32],
    cancelled: &dyn Fn() -> bool,
    on_chunk: impl FnMut(&[u8]),
) -> Result<(), CallError> {
    call(
        app,
        path,
        "draft",
        body,
        "application/json",
        STREAM_LIMIT,
        cancelled,
        Some(stamp),
        on_chunk,
    )
}
fn check(cancelled: &dyn Fn() -> bool) -> Result<(), CallError> {
    if cancelled() {
        Err(CallError::Cancelled)
    } else {
        Ok(())
    }
}
fn endpoint(origin: &Url, path: &str) -> Result<Url, CallError> {
    let path = path.strip_prefix('/').unwrap_or(path);
    let allowed = matches!(
        path,
        "api/screen/act"
            | "api/screen/ask"
            | "api/screen/circle-ask"
            | "api/screen/clips"
            | "api/screen/coach/recheck"
            | "api/screen/coach/resume"
            | "api/screen/coach/start"
            | "api/screen/coach/step"
            | "api/screen/destinations"
            | "api/screen/destinations/resolve"
            | "api/screen/entries/append"
            | "api/screen/entries/destination"
            | "api/screen/intent"
            | "api/screen/notes-check"
            | "api/screen/plan"
            | "api/screen/quiz"
            | "api/screen/quiz/answer"
            | "api/screen/read-question"
            | "api/screen/reanchor"
            | "api/screen/recipe"
            | "api/screen/watch"
            | "api/screen/write"
            | "api/handoff"
            | "api/handoff/brief"
    ) || path.strip_prefix("api/handoff/").is_some_and(|tail| {
        tail.split_once('/').is_some_and(|(id, action)| {
            is_uuid(id) && matches!(action, "package" | "finalize" | "device" | "device/package")
        })
    });
    if !allowed || !sign_in::allows_auth_transport(origin) {
        return Err(CallError::Failed);
    }
    let url = origin
        .join(&format!("/{path}"))
        .map_err(|_| CallError::Failed)?;
    if url.origin() != origin.origin() || url.query().is_some() || url.fragment().is_some() {
        return Err(CallError::Failed);
    }
    Ok(url)
}
fn client() -> Result<&'static Client, CallError> {
    static CLIENT: OnceLock<Result<Client, reqwest::Error>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
            Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(90))
                .build()
        })
        .as_ref()
        .map_err(|_| CallError::Failed)
}
#[allow(clippy::too_many_arguments)]
fn call<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    _label: &str,
    body: &[u8],
    content_type: &str,
    max_reply: usize,
    cancelled: &dyn Fn() -> bool,
    stamp: Option<&[u8; 32]>,
    on_chunk: impl FnMut(&[u8]),
) -> Result<(), CallError> {
    check(cancelled)?;
    let account = app.try_state::<SignIn>().ok_or(CallError::Failed)?;
    let url = endpoint(account.app_url(), path)?;
    check(cancelled)?;
    let token = mac_auth::load_token(account.app_url())
        .map_err(|_| CallError::Failed)?
        .ok_or_else(|| CallError::Account(NOT_CONNECTED.into()))?;
    if stamp.is_some_and(|expected| <[u8; 32]>::from(Sha256::digest(token.as_slice())) != *expected)
    {
        return Err(CallError::Cancelled);
    }
    check(cancelled)?;
    let device = mac_auth::device_id().ok_or(CallError::Failed)?;
    check(cancelled)?;
    let status = send(
        client()?,
        &url,
        body,
        token.as_slice(),
        &device,
        content_type,
        max_reply,
        cancelled,
        on_chunk,
    )?;
    check(cancelled)?;
    if status == 401 {
        sign_in::forget_rejected_token(app, token.as_slice()).map_err(|_| CallError::Failed)?;
        return Err(CallError::Account(SIGNED_OUT.into()));
    }
    status_result(status, &[])
}
// reqwest owns this reader until its worker finishes. Unlike Body::from(Vec), its source
// allocation is overwritten even on early disconnect, timeout or redirect refusal.
struct WipingReader {
    bytes: SecretBytes,
    offset: usize,
}
impl Read for WipingReader {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let count = output.len().min(self.bytes.len() - self.offset);
        output[..count].copy_from_slice(&self.bytes.as_slice()[self.offset..self.offset + count]);
        wipe(&mut self.bytes.as_mut_slice()[self.offset..self.offset + count]);
        self.offset += count;
        Ok(count)
    }
}
fn status_result(status: u16, head: &[u8]) -> Result<(), CallError> {
    match status {
        200 | 201 | 204 => Ok(()),
        401 => Ok(()), // caller compares and invalidates the credential under the account lock.
        _ => {
            if let Some(message) = limit_message(head) {
                Err(CallError::Limited(message))
            } else if status == 429 {
                Err(CallError::Busy)
            } else {
                Err(CallError::Failed)
            }
        }
    }
}
#[allow(clippy::too_many_arguments)]
fn send(
    client: &Client,
    url: &Url,
    body: &[u8],
    token: &[u8],
    device: &str,
    content_type: &str,
    max_reply: usize,
    cancelled: &dyn Fn() -> bool,
    mut on_chunk: impl FnMut(&[u8]),
) -> Result<u16, CallError> {
    check(cancelled)?;
    let token = std::str::from_utf8(token).map_err(|_| CallError::Failed)?;
    let mut text = format!("Bearer {token}");
    let authorization = HeaderValue::from_str(&text);
    // SAFETY: zeroing the UTF-8 bytes preserves valid UTF-8.
    wipe(unsafe { text.as_bytes_mut() });
    let mut authorization = authorization.map_err(|_| CallError::Failed)?;
    authorization.set_sensitive(true);
    let request = client
        .post(url.clone())
        .timeout(if url.path() == "/api/screen/intent" {
            Duration::from_secs(5)
        } else {
            Duration::from_secs(90)
        })
        .header(CONTENT_TYPE, content_type)
        .header(AUTHORIZATION, authorization)
        .header("X-Neb-Device", device)
        .header(
            "Accept",
            "application/json, application/x-ndjson, application/octet-stream",
        )
        .body(Body::sized(
            WipingReader {
                bytes: SecretBytes::from_vec(body.to_vec()),
                offset: 0,
            },
            body.len() as u64,
        ));
    check(cancelled)?;
    let response = request.send();
    check(cancelled)?;
    let mut response = response.map_err(|_| CallError::Failed)?;
    let status = response.status().as_u16();
    // An unauthorized request invalidates exactly its own credential, even if a proxy's
    // refusal body is oversized, malformed or never ends.
    if status == 401 {
        return Ok(status);
    }
    let success = matches!(status, 200 | 201 | 204);
    let limit = if success { max_reply } else { HEAD_LIMIT };
    let mut head = SecretBytes::zeroed(HEAD_LIMIT);
    let mut head_len = 0;
    let mut buffer = SecretBytes::zeroed(8192);
    let mut received = 0usize;
    loop {
        check(cancelled)?;
        // Read at most one extra byte to detect overflow; never deliver that byte.
        let capacity = buffer.len().min(limit.saturating_sub(received) + 1);
        let count = response.read(&mut buffer.as_mut_slice()[..capacity]);
        check(cancelled)?;
        let count = count.map_err(|_| CallError::Failed)?;
        if count == 0 {
            break;
        }
        received += count;
        if received > limit {
            if success {
                return Err(CallError::Failed);
            }
            break;
        }
        let keep = count.min(HEAD_LIMIT - head_len);
        head.as_mut_slice()[head_len..head_len + keep].copy_from_slice(&buffer.as_slice()[..keep]);
        head_len += keep;
        if success {
            check(cancelled)?;
            on_chunk(&buffer.as_slice()[..count]);
            check(cancelled)?;
        }
        buffer.wipe();
    }
    check(cancelled)?;
    status_result(status, &head.as_slice()[..head_len])?;
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        sync::atomic::{AtomicBool, Ordering},
    };
    fn mock(response: Vec<u8>) -> (Url, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!(
            "http://{}/api/screen/ask",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let task = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let request = BufReader::new(&socket)
                .lines()
                .map(Result::unwrap)
                .take_while(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            let _ = socket.write_all(&response);
            request
        });
        (url, task)
    }
    fn response(status: u16, body: &[u8]) -> Vec<u8> {
        let mut result = format!(
            "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        result.extend_from_slice(body);
        result
    }
    fn run(
        url: &Url,
        limit: usize,
        cancelled: &dyn Fn() -> bool,
        on_chunk: impl FnMut(&[u8]),
    ) -> Result<u16, CallError> {
        send(
            client().unwrap(),
            url,
            b"{}",
            b"synthetic-token",
            "synthetic-device",
            "application/json",
            limit,
            cancelled,
            on_chunk,
        )
    }
    #[test]
    fn endpoint_accepts_only_explicit_device_routes() {
        let origin = Url::parse("https://neb.test/nested/").unwrap();
        assert_eq!(
            endpoint(&origin, "api/screen/ask").unwrap().as_str(),
            "https://neb.test/api/screen/ask"
        );
        for path in [
            "https://evil.test/api/screen/ask",
            "//evil.test/api/screen/ask",
            "api/screen/../devices/revoke-self",
            "api/screen/ask?token=x",
            "api/screen/ask#x",
            "api/screen/unknown",
            "api/handoff/../brief",
            "api/handoff/not-a-uuid/device",
        ] {
            assert!(endpoint(&origin, path).is_err(), "{path}");
        }
        assert!(endpoint(&Url::parse("http://neb.test").unwrap(), "api/screen/ask").is_err());
    }
    #[test]
    fn headers_and_stream_are_native_and_bounded() {
        let (url, task) = mock(response(200, b"{\"type\":\"done\"}\n"));
        let mut reply = Vec::new();
        assert_eq!(
            run(&url, 1024, &|| false, |c| reply.extend_from_slice(c)),
            Ok(200)
        );
        assert_eq!(reply, b"{\"type\":\"done\"}\n");
        let request = task.join().unwrap().to_ascii_lowercase();
        assert!(request.contains("authorization: bearer synthetic-token"));
        assert!(request.contains("x-neb-device: synthetic-device"));
        let (url, task) = mock(response(200, &[b'x'; 1025]));
        let mut received = 0;
        assert_eq!(
            run(&url, 1024, &|| false, |c| received += c.len()),
            Err(CallError::Failed)
        );
        assert!(received <= 1024);
        task.join().unwrap();
        let (url, task) = mock(response(201, br#"{"clipId":"synthetic"}"#));
        let mut created = Vec::new();
        assert_eq!(
            run(&url, 1024, &|| false, |c| created.extend_from_slice(c)),
            Ok(201)
        );
        assert_eq!(created, br#"{"clipId":"synthetic"}"#);
        task.join().unwrap();
    }
    #[test]
    fn no_content_destination_response_succeeds_without_a_body() {
        let (url, task) = mock(response(204, b""));
        let mut delivered = 0;
        assert_eq!(
            run(&url, 1024, &|| false, |chunk| delivered += chunk.len()),
            Ok(204)
        );
        assert_eq!(delivered, 0);
        task.join().unwrap();
    }
    #[test]
    fn redirects_are_never_followed() {
        let sink = TcpListener::bind("127.0.0.1:0").unwrap();
        sink.set_nonblocking(true).unwrap();
        let (url, task) = mock(
            format!(
                "HTTP/1.1 307 Redirect\r\nLocation: http://{}/stolen\r\nContent-Length: 0\r\n\r\n",
                sink.local_addr().unwrap()
            )
            .into_bytes(),
        );
        assert_eq!(
            run(&url, 1024, &|| false, |_| panic!("redirect body delivered")),
            Err(CallError::Failed)
        );
        task.join().unwrap();
        assert_eq!(
            sink.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
    #[test]
    fn refusal_does_not_deliver_chunks_and_preserves_limit_messages() {
        let body = br#"{"error":"Daily allowance reached","code":"QUOTA_EXCEEDED"}"#;
        let (url, task) = mock(response(429, body));
        let expected = CallError::Limited("Daily allowance reached".into());
        assert_eq!(
            run(&url, 1024, &|| false, |_| panic!("refusal delivered")),
            Err(expected)
        );
        task.join().unwrap();
        let (url, task) = mock(response(401, b"{}"));
        assert_eq!(
            run(&url, 1024, &|| false, |_| panic!("refusal delivered")),
            Ok(401)
        );
        task.join().unwrap();
    }
    #[test]
    fn cancellation_before_send_and_after_chunk_stops_delivery() {
        let url = Url::parse("http://127.0.0.1:1/api/screen/ask").unwrap();
        assert_eq!(
            run(&url, 1024, &|| true, |_| panic!()),
            Err(CallError::Cancelled)
        );
        let (url, task) = mock(response(200, b"chunk"));
        let cancelled = AtomicBool::new(false);
        assert_eq!(
            run(&url, 1024, &|| cancelled.load(Ordering::SeqCst), |_| {
                cancelled.store(true, Ordering::SeqCst)
            }),
            Err(CallError::Cancelled)
        );
        task.join().unwrap();
    }
    #[test]
    fn timeout_is_bounded_by_client_without_delivering_data() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!(
            "http://{}/api/screen/ask",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let task = std::thread::spawn(move || {
            let (_socket, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(100));
        });
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(20))
            .build()
            .unwrap();
        assert_eq!(
            send(
                &client,
                &url,
                b"{}",
                b"synthetic-token",
                "device",
                "application/json",
                1024,
                &|| false,
                |_| panic!()
            ),
            Err(CallError::Failed)
        );
        task.join().unwrap();
    }
    #[test]
    fn wiping_reader_releases_only_requested_bytes() {
        let mut reader = WipingReader {
            bytes: SecretBytes::from_vec(b"secret".to_vec()),
            offset: 0,
        };
        let mut out = [0; 2];
        assert_eq!(reader.read(&mut out).unwrap(), 2);
        assert_eq!(&out, b"se");
        assert_eq!(reader.bytes.as_slice(), b"\0\0cret");
    }
}
