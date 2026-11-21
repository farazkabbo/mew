//! macOS platform services for the desktop account flow. The login Keychain's per-item
//! access control protects the stored device credential, scoped to this app and web origin.

use std::io::Read;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
use sha2::{Digest, Sha256};
use tauri::Url;

use crate::screen::protocol::{is_device_token, is_uuid};
use crate::screen::secret::{wipe, SecretBytes};

const TOKEN_SERVICE: &str = "app.mew.desktop.device-token";
const DEVICE_SERVICE: &str = "app.mew.desktop.device-id";
const ITEM_NOT_FOUND: i32 = -25300;

pub(super) const DEVICE: &str = "mac";

pub(super) fn random_bytes<const N: usize>() -> Result<[u8; N], ()> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(|_| ())?;
    Ok(bytes)
}

pub(super) fn sha256(input: &[u8]) -> Result<[u8; 32], ()> {
    Ok(Sha256::digest(input).into())
}

pub(super) fn device_name() -> String {
    "This Mac".to_owned()
}

pub(super) fn open_auth_page(url: &Url) {
    crate::origin::open_in_mac_browser(url);
}

pub(super) fn load_token(origin: &Url) -> Result<Option<SecretBytes>, ()> {
    match get_generic_password(TOKEN_SERVICE, &origin.origin().ascii_serialization()) {
        Ok(bytes) => {
            let token = SecretBytes::from_vec(bytes);
            Ok(std::str::from_utf8(token.as_slice())
                .is_ok_and(is_device_token)
                .then_some(token))
        }
        Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
        Err(_) => Err(()),
    }
}

pub(super) fn save_token(origin: &Url, token: &str) -> Result<(), ()> {
    set_generic_password(
        TOKEN_SERVICE,
        &origin.origin().ascii_serialization(),
        token.as_bytes(),
    )
    .map_err(|_| ())
}

pub(super) fn delete_token(origin: &Url) -> Result<(), ()> {
    match delete_generic_password(TOKEN_SERVICE, &origin.origin().ascii_serialization()) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
        Err(_) => Err(()),
    }
}

/// Stable across sign-ins. It is only sent to the configured origin.
fn device_id() -> Option<String> {
    static DEVICE_LOCK: Mutex<()> = Mutex::new(());
    let _guard = DEVICE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match get_generic_password(DEVICE_SERVICE, "local") {
        Ok(bytes) => {
            let id = String::from_utf8(bytes).ok()?;
            if is_uuid(&id) {
                return Some(id);
            }
        }
        Err(error) if error.code() == ITEM_NOT_FOUND => {}
        Err(_) => return None,
    }
    let id = uuid::Builder::from_random_bytes(random_bytes::<16>().ok()?)
        .into_uuid()
        .to_string();
    set_generic_password(DEVICE_SERVICE, "local", id.as_bytes()).ok()?;
    Some(id)
}

fn make_client() -> Result<Client, reqwest::Error> {
    // Use the same ring provider already enabled by the Tauri updater. reqwest's platform
    // verifier uses macOS certificate trust, with normal hostname verification.
    let _ = rustls::crypto::ring::default_provider().install_default();
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(15))
        .build()
}

fn client() -> Result<&'static Client, ()> {
    static CLIENT: OnceLock<Result<Client, reqwest::Error>> = OnceLock::new();
    CLIENT.get_or_init(make_client).as_ref().map_err(|_| ())
}

pub(super) fn post(
    origin: &Url,
    url: &Url,
    body: &[u8],
    token: Option<&str>,
    on_chunk: impl FnMut(&[u8]),
) -> Result<u16, ()> {
    if url.origin() != origin.origin() || !super::sign_in::allows_auth_transport(url) {
        return Err(());
    }
    let device_id = device_id().ok_or(())?;
    send(client()?, url, body, token, &device_id, on_chunk)
}

fn send(
    client: &Client,
    url: &Url,
    body: &[u8],
    token: Option<&str>,
    device_id: &str,
    mut on_chunk: impl FnMut(&[u8]),
) -> Result<u16, ()> {
    let mut request = client
        .post(url.clone())
        .header(CONTENT_TYPE, "application/json")
        .body(body.to_vec());
    if let Some(token) = token {
        let mut header = format!("Bearer {token}");
        let value = HeaderValue::from_str(&header);
        // SAFETY: zero bytes are valid UTF-8.
        wipe(unsafe { header.as_bytes_mut() });
        let mut value = value.map_err(|_| ())?;
        value.set_sensitive(true);
        request = request.header(AUTHORIZATION, value);
    }
    request = request.header("X-Neb-Device", device_id);
    let response = request.send().map_err(|_| ())?;
    let status = response.status().as_u16();
    // The reply can contain secrets. Leave the extra byte for the caller's overflow check.
    let mut response = response.take(super::sign_in::MAX_REPLY_BYTES as u64 + 1);
    let mut buffer = SecretBytes::zeroed(4096);
    loop {
        let count = response.read(buffer.as_mut_slice()).map_err(|_| ())?;
        if count == 0 {
            return Ok(status);
        }
        on_chunk(&buffer.as_slice()[..count]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    #[test]
    #[ignore = "requires a loopback TCP listener"]
    fn posts_with_the_native_headers_and_never_follows_redirects() {
        // No Keychain writes: all credentials in this test are mock strings.
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = Url::parse(&format!("http://{}/", server.local_addr().unwrap())).unwrap();
        let sink = TcpListener::bind("127.0.0.1:0").unwrap();
        sink.set_nonblocking(true).unwrap();
        let redirect = format!("http://{}/elsewhere", sink.local_addr().unwrap());
        let serve = std::thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let request = BufReader::new(&stream)
                .lines()
                .map(Result::unwrap)
                .take_while(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
                .to_ascii_lowercase();
            assert!(request.starts_with("post /api/devices/revoke-self "));
            assert!(request.contains("authorization: bearer synthetic-device-token"));
            assert!(request.contains("x-neb-device: synthetic-device-id"));
            let body = vec![b'x'; super::super::sign_in::MAX_REPLY_BYTES + 256];
            write!(
                stream,
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: {redirect}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len(),
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        });
        let mut received = 0;
        assert_eq!(
            send(
                &make_client().unwrap(),
                &origin.join("api/devices/revoke-self").unwrap(),
                b"{}",
                Some("synthetic-device-token"),
                "synthetic-device-id",
                |chunk| received += chunk.len(),
            ),
            Ok(307)
        );
        assert_eq!(received, super::super::sign_in::MAX_REPLY_BYTES + 1);
        serve.join().unwrap();
        assert_eq!(
            sink.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}
