//! Randomness and SHA-256 from Windows' own cryptography (CNG): no extra crate needed.

use windows::Win32::Security::Cryptography::{
    BCryptGenRandom, BCryptHash, BCRYPT_SHA256_ALG_HANDLE, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
};

use crate::screen::base64;

/// Cryptographically random bytes (the system's preferred generator).
pub fn random_bytes<const N: usize>() -> Result<[u8; N], i32> {
    let mut bytes = [0u8; N];
    // SAFETY: the buffer is valid for its length; no algorithm handle with the system RNG flag.
    unsafe { BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }
        .ok()
        .map_err(|e| e.code().0)?;
    Ok(bytes)
}

pub fn sha256(input: &[u8]) -> Result<[u8; 32], i32> {
    let mut digest = [0u8; 32];
    // SAFETY: the SHA-256 pseudo-handle needs no setup (Windows 10+); buffers are valid.
    unsafe { BCryptHash(BCRYPT_SHA256_ALG_HANDLE, None, input, &mut digest) }
        .ok()
        .map_err(|e| e.code().0)?;
    Ok(digest)
}

/// A PKCE pair (RFC 7636, S256): the verifier stays in the desktop app; only the challenge is
/// shown to the web page.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn new_pkce() -> Result<Pkce, i32> {
    let verifier = base64::encode_url_safe(&random_bytes::<32>()?);
    let challenge = challenge_for(&verifier)?;
    Ok(Pkce {
        verifier,
        challenge,
    })
}

pub fn challenge_for(verifier: &str) -> Result<String, i32> {
    Ok(base64::encode_url_safe(&sha256(verifier.as_bytes())?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_rfc_7636() {
        // RFC 7636 appendix B.
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").unwrap(),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn makes_fresh_verifiers_of_the_right_shape() {
        let a = new_pkce().unwrap();
        let b = new_pkce().unwrap();
        assert_ne!(a.verifier, b.verifier);
        assert_eq!(a.verifier.len(), 43);
        assert_eq!(a.challenge.len(), 43);
        assert_eq!(challenge_for(&a.verifier).unwrap(), a.challenge);
    }

    #[test]
    fn hashes_known_input() {
        let digest = sha256(b"abc").unwrap();
        assert_eq!(digest[..4], [0xba, 0x78, 0x16, 0xbf]);
    }
}
