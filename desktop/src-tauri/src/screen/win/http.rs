//! A small HTTPS client on WinHTTP (built into Windows; no new crate). It sends the request body
//! straight from our buffer, so the screenshot isn't copied into a library's memory first.
//!
//! Synchronous: call it from a worker thread. Redirects are never followed (a redirect could
//! carry the device token elsewhere); TLS and proxy settings are the system's.

use std::ffi::c_void;

use tauri::Url;
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders,
    WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetOption,
    WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_FLAG_SECURE,
    WINHTTP_OPEN_REQUEST_FLAGS, WINHTTP_OPTION_REDIRECT_POLICY,
    WINHTTP_OPTION_REDIRECT_POLICY_NEVER, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
};

/// Replies larger than this are cut off (a full Screen Coach reply is a few kilobytes).
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const CONNECT_TIMEOUT_MS: i32 = 10_000;
/// Long enough for a model to answer; the server times out first.
const RECEIVE_TIMEOUT_MS: i32 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpError {
    /// Not an http(s) URL with a host.
    BadUrl,
    /// The network or server failed (WinHTTP error code, for the log).
    Network(i32),
}

impl From<windows::core::Error> for HttpError {
    fn from(error: windows::core::Error) -> Self {
        HttpError::Network(error.code().0)
    }
}

/// A WinHTTP handle, closed when dropped.
struct Handle(*mut c_void);

impl Handle {
    fn new(raw: *mut c_void) -> Result<Self, HttpError> {
        if raw.is_null() {
            Err(HttpError::Network(
                windows::core::Error::from_thread().code().0,
            ))
        } else {
            Ok(Self(raw))
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle came from WinHTTP and is closed exactly once.
        let _ = unsafe { WinHttpCloseHandle(self.0) };
    }
}

/// POSTs `body` to `url` and streams the response body to `on_chunk`. Returns the HTTP status.
/// `headers` are "Name: value" lines; they may hold a secret, so their UTF-16 copy is wiped.
pub fn post(
    url: &Url,
    headers: &[String],
    body: &[u8],
    on_chunk: impl FnMut(&[u8]),
) -> Result<u16, HttpError> {
    request(w!("POST"), url, headers, body, on_chunk)
}

/// GETs `url` with no headers (nothing of the student's goes with it) and streams the response
/// body to `on_chunk`. Returns the HTTP status.
pub fn get(url: &Url, on_chunk: impl FnMut(&[u8])) -> Result<u16, HttpError> {
    request(w!("GET"), url, &[], &[], on_chunk)
}

fn request(
    method: PCWSTR,
    url: &Url,
    headers: &[String],
    body: &[u8],
    mut on_chunk: impl FnMut(&[u8]),
) -> Result<u16, HttpError> {
    let secure = match url.scheme() {
        "https" => true,
        "http" => false,
        _ => return Err(HttpError::BadUrl),
    };
    let host = HSTRING::from(url.host_str().ok_or(HttpError::BadUrl)?);
    let port = url.port_or_known_default().ok_or(HttpError::BadUrl)?;
    let path = HSTRING::from(match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_owned(),
    });
    let flags = if secure {
        WINHTTP_FLAG_SECURE
    } else {
        WINHTTP_OPEN_REQUEST_FLAGS(0)
    };

    // SAFETY: each WinHTTP call gets handles created just before (kept alive by the `Handle`s
    // until the end of this function) and buffers valid for the call's duration.
    unsafe {
        let session = Handle::new(WinHttpOpen(
            w!("Mew-Desktop"),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        ))?;
        WinHttpSetTimeouts(
            session.0,
            CONNECT_TIMEOUT_MS,
            CONNECT_TIMEOUT_MS,
            RECEIVE_TIMEOUT_MS,
            RECEIVE_TIMEOUT_MS,
        )?;
        let connection = Handle::new(WinHttpConnect(session.0, &host, port, 0))?;
        let request = Handle::new(WinHttpOpenRequest(
            connection.0,
            method,
            &path,
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            flags,
        ))?;
        WinHttpSetOption(
            Some(request.0.cast_const()),
            WINHTTP_OPTION_REDIRECT_POLICY,
            Some(&WINHTTP_OPTION_REDIRECT_POLICY_NEVER.to_le_bytes()),
        )?;

        let mut header_text: Vec<u16> = headers
            .iter()
            .flat_map(|h| h.encode_utf16().chain("\r\n".encode_utf16()))
            .collect();
        let length = u32::try_from(body.len()).map_err(|_| HttpError::BadUrl)?;
        // No headers: no buffer at all. With a length of 0, WinHTTP reads a buffer it's given up
        // to a terminating null, and an empty Vec's pointer points at nothing (a crash, as a GET
        // with no headers was).
        let sent = WinHttpSendRequest(
            request.0,
            (!header_text.is_empty()).then_some(header_text.as_slice()),
            (!body.is_empty()).then(|| body.as_ptr().cast()),
            length,
            length,
            0,
        );
        header_text
            .iter_mut()
            .for_each(|unit| std::ptr::write_volatile(unit, 0));
        sent?;
        WinHttpReceiveResponse(request.0, std::ptr::null_mut())?;

        let mut status = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some((&mut status as *mut u32).cast()),
            &mut size,
            std::ptr::null_mut(),
        )?;

        let mut buffer = [0u8; 8192];
        let mut total = 0usize;
        loop {
            let mut read = 0u32;
            WinHttpReadData(
                request.0,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                &mut read,
            )?;
            if read == 0 || total >= MAX_RESPONSE_BYTES {
                break;
            }
            total += read as usize;
            on_chunk(&buffer[..read as usize]);
        }
        Ok(u16::try_from(status).unwrap_or(0))
    }
}
