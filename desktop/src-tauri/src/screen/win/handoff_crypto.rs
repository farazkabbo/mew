//! Handoff's cryptography, with Windows' own (no new crate):
//! - DPAPI (`protect` / `unprotect`): the session timeline's records, readable only by this user
//!   on this computer;
//! - AES-256-GCM through CNG (`seal` / `open`): the package, with a random content key, in the
//!   layout the server and the browser read: "NEBH1" | 12-byte nonce | ciphertext | 16-byte tag.

use windows::core::w;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    BCryptCloseAlgorithmProvider, BCryptDecrypt, BCryptDestroyKey, BCryptEncrypt,
    BCryptGenerateSymmetricKey, BCryptOpenAlgorithmProvider, BCryptSetProperty, CryptProtectData,
    CryptUnprotectData, BCRYPT_AES_ALGORITHM, BCRYPT_ALG_HANDLE,
    BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO, BCRYPT_CHAINING_MODE, BCRYPT_FLAGS, BCRYPT_HANDLE,
    BCRYPT_KEY_HANDLE, BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS, CRYPTPROTECT_UI_FORBIDDEN,
    CRYPT_INTEGER_BLOB,
};

pub const MAGIC: &[u8] = b"NEBH1";
const NONCE: usize = 12;
const TAG: usize = 16;

/// Encrypts for this user on this computer (DPAPI).
pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len()).ok()?,
        pbData: data.as_ptr().cast_mut(),
    };
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: valid input blob for the call; the output is freed with LocalFree below.
    unsafe {
        CryptProtectData(
            &input,
            w!("neb handoff timeline"),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
        .ok()?;
        let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData.cast())));
        Some(bytes)
    }
}

pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len()).ok()?,
        pbData: data.as_ptr().cast_mut(),
    };
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: as in `protect`.
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
        .ok()?;
        let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData.cast())));
        Some(bytes)
    }
}

/// An AES-GCM key on CNG, released on drop.
struct Key {
    alg: BCRYPT_ALG_HANDLE,
    key: BCRYPT_KEY_HANDLE,
}

impl Key {
    fn new(secret: &[u8; 32]) -> Option<Key> {
        let mut alg = BCRYPT_ALG_HANDLE::default();
        // SAFETY: out pointers valid; handles closed in Drop.
        unsafe {
            BCryptOpenAlgorithmProvider(
                &mut alg,
                BCRYPT_AES_ALGORITHM,
                None,
                BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS(0),
            )
            .ok()
            .ok()?;
            let mode: Vec<u8> = "ChainingModeGCM\0"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect();
            if BCryptSetProperty(BCRYPT_HANDLE(alg.0), BCRYPT_CHAINING_MODE, &mode, 0).is_err() {
                let _ = BCryptCloseAlgorithmProvider(alg, 0);
                return None;
            }
            let mut key = BCRYPT_KEY_HANDLE::default();
            if BCryptGenerateSymmetricKey(alg, &mut key, None, secret, 0).is_err() {
                let _ = BCryptCloseAlgorithmProvider(alg, 0);
                return None;
            }
            Some(Key { alg, key })
        }
    }
}

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: handles created in `new`, released once.
        unsafe {
            let _ = BCryptDestroyKey(self.key);
            let _ = BCryptCloseAlgorithmProvider(self.alg, 0);
        }
    }
}

fn info(nonce: &mut [u8; NONCE], tag: &mut [u8; TAG]) -> BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO {
    BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO {
        cbSize: std::mem::size_of::<BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO>() as u32,
        dwInfoVersion: 1,
        pbNonce: nonce.as_mut_ptr(),
        cbNonce: NONCE as u32,
        pbTag: tag.as_mut_ptr(),
        cbTag: TAG as u32,
        ..Default::default()
    }
}

/// Encrypts `plain` with `key` and a fresh random nonce, in the package layout.
pub fn seal(key: &[u8; 32], plain: &[u8]) -> Option<Vec<u8>> {
    let mut nonce: [u8; NONCE] = super::crypto::random_bytes().ok()?;
    let mut tag = [0u8; TAG];
    let k = Key::new(key)?;
    let mut out = vec![0u8; plain.len()];
    let mut written = 0u32;
    let auth = info(&mut nonce, &mut tag);
    // SAFETY: buffers sized for GCM (no padding: output = input length); `auth` points at the
    // nonce and tag arrays, alive for the call.
    unsafe {
        BCryptEncrypt(
            k.key,
            Some(plain),
            Some(&auth as *const _ as *const _),
            None,
            Some(&mut out),
            &mut written,
            BCRYPT_FLAGS(0),
        )
        .ok()
        .ok()?;
    }
    let mut sealed = Vec::with_capacity(MAGIC.len() + NONCE + plain.len() + TAG);
    sealed.extend_from_slice(MAGIC);
    sealed.extend_from_slice(&nonce);
    sealed.extend_from_slice(&out[..written as usize]);
    sealed.extend_from_slice(&tag);
    Some(sealed)
}

/// Decrypts a package (None if it isn't one, or was changed, or the key is wrong).
pub fn open(key: &[u8; 32], sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < MAGIC.len() + NONCE + TAG || !sealed.starts_with(MAGIC) {
        return None;
    }
    let mut nonce = [0u8; NONCE];
    nonce.copy_from_slice(&sealed[MAGIC.len()..MAGIC.len() + NONCE]);
    let mut tag = [0u8; TAG];
    tag.copy_from_slice(&sealed[sealed.len() - TAG..]);
    let body = &sealed[MAGIC.len() + NONCE..sealed.len() - TAG];
    let k = Key::new(key)?;
    let mut out = vec![0u8; body.len()];
    let mut written = 0u32;
    let auth = info(&mut nonce, &mut tag);
    // SAFETY: as in `seal`; a wrong tag makes the call fail.
    unsafe {
        BCryptDecrypt(
            k.key,
            Some(body),
            Some(&auth as *const _ as *const _),
            None,
            Some(&mut out),
            &mut written,
            BCRYPT_FLAGS(0),
        )
        .ok()
        .ok()?;
    }
    out.truncate(written as usize);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seals_and_opens_and_refuses_tampering() {
        let key = [7u8; 32];
        let sealed = seal(&key, b"{\"manifest\":1}").unwrap();
        assert!(sealed.starts_with(MAGIC));
        assert_eq!(open(&key, &sealed).unwrap(), b"{\"manifest\":1}");
        let mut flipped = sealed.clone();
        let i = flipped.len() / 2;
        flipped[i] ^= 1;
        assert!(open(&key, &flipped).is_none());
        assert!(open(&[8u8; 32], &sealed).is_none());
        // Two seals of the same text differ (a fresh nonce each time).
        assert_ne!(seal(&key, b"x").unwrap(), seal(&key, b"x").unwrap());
    }

    #[test]
    fn dpapi_round_trips() {
        let p = protect(b"timeline record").unwrap();
        assert_ne!(p, b"timeline record");
        assert_eq!(unprotect(&p).unwrap(), b"timeline record");
    }

    /// The same AES-GCM and layout as the server and the browser: a package sealed by Node's
    /// crypto (key 01…, nonce 02…) opens here.
    #[test]
    fn opens_what_node_sealed() {
        const NODE: &str = "4e454248310202020202020202020202027cf4a428243ea798a0b89ef27ec1b0ddcf95bf808fd4af0cb50abc15d7fbb45334de66e7b03062b3";
        let bytes: Vec<u8> = (0..NODE.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&NODE[i..i + 2], 16).unwrap())
            .collect();
        assert_eq!(
            open(&[1u8; 32], &bytes).unwrap(),
            br#"{"manifest":"from node"}"#
        );
        let sealed = seal(&[1u8; 32], b"abc").unwrap();
        assert_eq!(sealed.len(), MAGIC.len() + NONCE + 3 + TAG);
    }
}
