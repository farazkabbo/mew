//! The device token in Windows Credential Manager (decision 8): protected by Windows for this
//! user on this computer, never in a file, the registry or a web page's storage.

use windows::core::{w, PCWSTR, PWSTR};
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};

use crate::screen::protocol::is_device_token;
use crate::screen::secret::{wipe, SecretBytes};

/// Shown in Control Panel → Credential Manager → Windows Credentials.
const TARGET: PCWSTR = w!("Mew/ScreenCoach/DeviceToken");

/// Stores the token, replacing any earlier one.
pub fn save(token: &str) -> windows::core::Result<()> {
    let mut blob = token.as_bytes().to_vec();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(TARGET.as_ptr().cast_mut()),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        // This user on this computer only (not roaming to other machines).
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: PWSTR(w!("Screen Coach").as_ptr().cast_mut()),
        ..Default::default()
    };
    // SAFETY: every pointer in `credential` stays valid for the call; Windows copies the data.
    let result = unsafe { CredWriteW(&credential, 0) };
    wipe(&mut blob);
    result
}

/// The stored token, if there is a valid one.
pub fn load() -> Option<SecretBytes> {
    let mut found: *mut CREDENTIALW = std::ptr::null_mut();
    // SAFETY: `found` receives a buffer Windows allocates; it's freed with CredFree below.
    unsafe { CredReadW(TARGET, CRED_TYPE_GENERIC, None, &mut found) }.ok()?;
    // SAFETY: CredReadW succeeded, so `found` points to a valid CREDENTIALW whose blob has
    // `CredentialBlobSize` bytes; we copy it out and wipe Windows' copy before freeing it.
    let token = unsafe {
        let credential = &*found;
        let blob = std::slice::from_raw_parts_mut(
            credential.CredentialBlob,
            credential.CredentialBlobSize as usize,
        );
        let mut copy = SecretBytes::zeroed(blob.len());
        copy.as_mut_slice().copy_from_slice(blob);
        wipe(blob);
        CredFree(found.cast());
        copy
    };
    std::str::from_utf8(token.as_slice())
        .is_ok_and(is_device_token)
        .then_some(token)
}

pub fn is_saved() -> bool {
    load().is_some()
}

/// Forgets the token (disconnecting, or after the server said it's revoked).
pub fn delete() {
    // SAFETY: a constant target name; a missing credential is not an error worth reporting.
    let _ = unsafe { CredDeleteW(TARGET, CRED_TYPE_GENERIC, None) };
}

/// This computer's own id for Neb (docs/LAUNCH_LIMITS.md): a random UUID made on first use and
/// kept in Credential Manager, so reinstalling Neb or signing in with another account doesn't
/// give the computer a fresh allowance. The server only ever stores a hash of it.
const DEVICE_ID_TARGET: PCWSTR = w!("Neb/DeviceId");

/// The computer's id, made and saved the first time it's asked for.
pub fn device_id() -> Option<String> {
    if let Some(id) = read_device_id() {
        return Some(id);
    }
    let bytes = super::crypto::random_bytes::<16>().ok()?;
    let id = uuid_v4(bytes);
    let mut blob = id.as_bytes().to_vec();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(DEVICE_ID_TARGET.as_ptr().cast_mut()),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: PWSTR(w!("Neb").as_ptr().cast_mut()),
        ..Default::default()
    };
    // SAFETY: every pointer in `credential` stays valid for the call; Windows copies the data.
    unsafe { CredWriteW(&credential, 0) }.ok()?;
    Some(id)
}

fn read_device_id() -> Option<String> {
    let mut found: *mut CREDENTIALW = std::ptr::null_mut();
    // SAFETY: `found` receives a buffer Windows allocates; it's freed with CredFree below.
    unsafe { CredReadW(DEVICE_ID_TARGET, CRED_TYPE_GENERIC, None, &mut found) }.ok()?;
    // SAFETY: CredReadW succeeded, so `found` points to a valid CREDENTIALW with a blob of
    // `CredentialBlobSize` bytes, copied out before it's freed.
    let id = unsafe {
        let credential = &*found;
        let blob = std::slice::from_raw_parts(
            credential.CredentialBlob,
            credential.CredentialBlobSize as usize,
        );
        let text = String::from_utf8(blob.to_vec()).ok();
        CredFree(found.cast());
        text
    }?;
    is_uuid_text(&id).then_some(id)
}

/// A version 4 UUID from 16 random bytes, in lower-case hex.
pub fn uuid_v4(mut bytes: [u8; 16]) -> String {
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn is_uuid_text(text: &str) -> bool {
    crate::screen::protocol::is_uuid(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_id_is_a_version_4_uuid() {
        let id = uuid_v4([0xff; 16]);
        assert!(is_uuid_text(&id));
        assert_eq!(id, "ffffffff-ffff-4fff-bfff-ffffffffffff");
    }
}
