//! Base64 (RFC 4648), written out here because it's tiny and lets the screenshot be encoded
//! straight into a buffer we can wipe (`SecretBytes`), which a library's `String` can't promise.

const STANDARD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_SAFE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Standard base64 with padding, appended to `out`.
pub fn encode_into(input: &[u8], out: &mut Vec<u8>) {
    encode_with(input, STANDARD, true, out);
}

/// URL-safe base64 without padding (as PKCE uses).
pub fn encode_url_safe(input: &[u8]) -> String {
    let mut out = Vec::with_capacity(encoded_len(input.len()));
    encode_with(input, URL_SAFE, false, &mut out);
    // Only ASCII from the alphabet was written.
    String::from_utf8(out).unwrap_or_default()
}

/// Length of the padded standard encoding of `n` bytes.
pub fn encoded_len(n: usize) -> usize {
    n.div_ceil(3) * 4
}

fn encode_with(input: &[u8], alphabet: &[u8; 64], pad: bool, out: &mut Vec<u8>) {
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let symbols = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63];
        let used = chunk.len() + 1;
        for (i, &symbol) in symbols.iter().enumerate() {
            if i < used {
                out.push(alphabet[symbol as usize]);
            } else if pad {
                out.push(b'=');
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn standard(input: &[u8]) -> String {
        let mut out = Vec::new();
        encode_into(input, &mut out);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn matches_the_rfc_4648_test_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(standard(input.as_bytes()), expected, "{input:?}");
            assert_eq!(encoded_len(input.len()), expected.len());
        }
    }

    #[test]
    fn url_safe_uses_dash_and_underscore_without_padding() {
        assert_eq!(encode_url_safe(&[0xfb, 0xff]), "-_8");
        assert_eq!(standard(&[0xfb, 0xff]), "+/8=");
    }
}
