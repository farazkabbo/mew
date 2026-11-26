//! Native CryptoKit AES-256-GCM with the canonical Windows/browser NEBH1 envelope. Timeline
//! keys live in Keychain, scoped to the configured origin AND the native credential identity.
use crate::screen::secret::SecretBytes;
use security_framework::passwords::{get_generic_password, set_generic_password};
use std::sync::Mutex;
const MAX: usize = 25 * 1024 * 1024;
const OVERHEAD: usize = 33;
pub const MAGIC: &[u8] = b"NEBH1";
unsafe extern "C" {
    fn neb_handoff_seal(
        key: *const u8,
        nonce: *const u8,
        input: *const u8,
        length: usize,
        output: *mut u8,
        capacity: usize,
        written: *mut usize,
    ) -> i32;
    fn neb_handoff_open(
        key: *const u8,
        input: *const u8,
        length: usize,
        output: *mut u8,
        capacity: usize,
        written: *mut usize,
    ) -> i32;
    fn neb_handoff_image(
        input: *const u8,
        length: usize,
        op: i32,
        left: usize,
        top: usize,
        right: usize,
        bottom: usize,
        max_side: usize,
        output: *mut u8,
        capacity: usize,
        written: *mut usize,
    ) -> i32;
}
pub fn seal(key: &[u8; 32], plain: &[u8]) -> Option<SecretBytes> {
    if plain.len() > MAX {
        return None;
    }
    let mut nonce = [0; 12];
    getrandom::fill(&mut nonce).ok()?;
    let mut output = SecretBytes::zeroed(plain.len() + OVERHEAD);
    let mut written = 0;
    // SAFETY: all pointers are live for this synchronous call; fixed key/nonce lengths and
    // output capacity exactly cover the authenticated envelope. Swift retains no pointers.
    let status = unsafe {
        neb_handoff_seal(
            key.as_ptr(),
            nonce.as_ptr(),
            plain.as_ptr(),
            plain.len(),
            output.as_mut_slice().as_mut_ptr(),
            output.len(),
            &mut written,
        )
    };
    (status == 0 && written == output.len()).then_some(output)
}
pub fn open(key: &[u8; 32], sealed: &[u8]) -> Option<SecretBytes> {
    if sealed.len() < OVERHEAD || sealed.len() > MAX + OVERHEAD || !sealed.starts_with(MAGIC) {
        return None;
    }
    let mut output = SecretBytes::zeroed(sealed.len() - OVERHEAD);
    let mut written = 0;
    // SAFETY: bounded borrowed input and caller-owned destination; native authenticated open
    // never delivers bytes before GCM verification, and all failure buffers are wiped on drop.
    let status = unsafe {
        neb_handoff_open(
            key.as_ptr(),
            sealed.as_ptr(),
            sealed.len(),
            output.as_mut_slice().as_mut_ptr(),
            output.len(),
            &mut written,
        )
    };
    (status == 0 && written == output.len()).then_some(output)
}
fn timeline_key(scope: &str) -> Option<SecretBytes> {
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    match get_generic_password("app.mew.desktop.handoff-key", scope) {
        Ok(bytes) if bytes.len() == 32 => Some(SecretBytes::from_vec(bytes)),
        Ok(_) => None,
        Err(e) if e.code() == -25300 => {
            let mut key = SecretBytes::zeroed(32);
            getrandom::fill(key.as_mut_slice()).ok()?;
            set_generic_password("app.mew.desktop.handoff-key", scope, key.as_slice()).ok()?;
            Some(key)
        }
        Err(_) => None,
    }
}
pub fn protect(scope: &str, plain: &[u8]) -> Option<SecretBytes> {
    let key = timeline_key(scope)?;
    seal(key.as_slice().try_into().ok()?, plain)
}
pub fn unprotect(scope: &str, sealed: &[u8]) -> Option<SecretBytes> {
    let key = timeline_key(scope)?;
    open(key.as_slice().try_into().ok()?, sealed)
}
pub fn image(jpeg: &[u8], cover: Option<[u32; 4]>, max_side: usize) -> Option<SecretBytes> {
    if jpeg.len() > 10 * 1024 * 1024 || max_side == 0 || max_side > 2400 {
        return None;
    }
    let mut output = SecretBytes::zeroed(10 * 1024 * 1024);
    let mut written = 0;
    let [l, t, r, b] = cover.unwrap_or([0; 4]);
    // SAFETY: bounded inputs and caller-owned output; native image work retains no pointers.
    let status = unsafe {
        neb_handoff_image(
            jpeg.as_ptr(),
            jpeg.len(),
            i32::from(cover.is_some()),
            l as usize,
            t as usize,
            r as usize,
            b as usize,
            max_side,
            output.as_mut_slice().as_mut_ptr(),
            output.len(),
            &mut written,
        )
    };
    if status != 0 || written == 0 || written > output.len() {
        return None;
    }
    output.truncate(written);
    Some(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_crypto_round_trips_and_refuses_tampering() {
        let key = [7; 32];
        let sealed = seal(&key, b"synthetic manifest").unwrap();
        assert!(sealed.as_slice().starts_with(MAGIC));
        assert_eq!(
            open(&key, sealed.as_slice()).unwrap().as_slice(),
            b"synthetic manifest"
        );
        assert!(open(&[8; 32], sealed.as_slice()).is_none());
        let mut modified = SecretBytes::from_vec(sealed.as_slice().to_vec());
        modified.as_mut_slice()[18] ^= 1;
        assert!(open(&key, modified.as_slice()).is_none());
        assert_ne!(
            seal(&key, b"x").unwrap().as_slice(),
            seal(&key, b"x").unwrap().as_slice()
        );
    }
    #[test]
    fn opens_browser_node_fixture() {
        const NODE:&str="4e454248310202020202020202020202027cf4a428243ea798a0b89ef27ec1b0ddcf95bf808fd4af0cb50abc15d7fbb45334de66e7b03062b3";
        let data = (0..NODE.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&NODE[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            open(&[1; 32], &data).unwrap().as_slice(),
            br#"{"manifest":"from node"}"#
        );
        assert!(open(&[1; 32], b"NEBH1").is_none());
    }
}
