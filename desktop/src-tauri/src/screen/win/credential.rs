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
