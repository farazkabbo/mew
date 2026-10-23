//! Byte buffers for screen pixels: overwritten with zeros when dropped, never printed.
//!
//! Screenshots live only in memory (brief §7.2). Zeroing is "where practical": it covers the
//! buffers we own, not copies made inside Windows (the capture surface, the encoder's internal
//! state), which are released as soon as we're done with them.

use std::fmt;
use std::sync::atomic::{compiler_fence, Ordering};

/// Bytes that must not outlive their use. Deliberately not `Clone`, `Serialize` or `Display`.
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    /// A zero-filled buffer of `len` bytes.
    pub fn zeroed(len: usize) -> Self {
        Self(vec![0; len])
    }

    /// Takes ownership of bytes that are already secret (they're wiped when this is dropped).
    pub fn from_vec(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }

    pub fn as_mut_slice(&mut self) -> &mut [u8] {
        &mut self.0
    }

    /// Shortens the buffer, zeroing the bytes it drops first.
    pub fn truncate(&mut self, len: usize) {
        if len < self.0.len() {
            wipe(&mut self.0[len..]);
            self.0.truncate(len);
        }
    }

    /// Overwrites every byte with zero (the length is kept).
    pub fn wipe(&mut self) {
        wipe(&mut self.0);
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        // The whole allocation, including spare capacity a truncate left behind.
        let capacity = self.0.capacity();
        self.0.resize(capacity, 0);
        wipe(&mut self.0);
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SecretBytes({} bytes)", self.0.len())
    }
}

/// Zeroes `bytes` with volatile writes, so the compiler can't skip it as a dead store.
pub fn wipe(bytes: &mut [u8]) {
    for byte in bytes.iter_mut() {
        // SAFETY: `byte` is a valid, aligned, exclusive reference into the slice.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wipes_and_truncates() {
        let mut bytes = SecretBytes::zeroed(8);
        bytes
            .as_mut_slice()
            .copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        bytes.truncate(3);
        assert_eq!(bytes.as_slice(), &[1, 2, 3]);
        bytes.wipe();
        assert_eq!(bytes.as_slice(), &[0, 0, 0]);
        assert_eq!(bytes.len(), 3);
    }

    #[test]
    fn never_prints_its_contents() {
        let mut bytes = SecretBytes::zeroed(4);
        bytes.as_mut_slice().copy_from_slice(b"pass");
        assert_eq!(format!("{bytes:?}"), "SecretBytes(4 bytes)");
    }
}
