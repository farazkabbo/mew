//! The Windows adapter for the shared desktop account flow. Screen Coach keeps using the same
//! WinHTTP client and Credential Manager entry.

use tauri::Url;

use crate::screen::account::wipe_string;
use crate::screen::secret::SecretBytes;

pub use super::crypto::{random_bytes, sha256};
pub use super::system::device_name;

pub const DEVICE: &str = "windows";

pub fn open_auth_page(url: &Url) {
    super::system::open_web_app_page(url);
}

pub fn load_token(_origin: &Url) -> Result<Option<SecretBytes>, ()> {
    Ok(super::credential::load())
}

pub fn save_token(_origin: &Url, token: &str) -> Result<(), ()> {
    super::credential::save(token).map_err(|_| ())
}

pub fn delete_token(_origin: &Url) -> Result<(), ()> {
    super::credential::delete();
    Ok(())
}

pub fn post(
    _origin: &Url,
    url: &Url,
    body: &[u8],
    token: Option<&str>,
    on_chunk: impl FnMut(&[u8]),
) -> Result<u16, ()> {
    let mut headers = vec!["Content-Type: application/json".to_owned()];
    if let Some(token) = token {
        headers.push(format!("Authorization: Bearer {token}"));
    }
    let result = super::http::post(url, &headers, body, on_chunk).map_err(|_| ());
    headers.iter_mut().for_each(|header| wipe_string(header));
    result
}
