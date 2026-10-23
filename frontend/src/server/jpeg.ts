import "server-only";

import { SCREEN_LIMITS } from "@mew/shared";

import { HttpError } from "./http-error";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Start-of-frame markers carry the image size (all SOFn except DHT, JPG and DAC). */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * Checks that base64 from the desktop app really is a JPEG of sane dimensions before it's
 * forwarded to a model or stored: other formats, huge images and junk are rejected with 400.
 */
export function assertJpeg(
  base64: string,
  max: number = SCREEN_LIMITS.imagePixelsPerSide,
): { width: number; height: number } {
  if (!BASE64.test(base64)) throw new HttpError(400, "Image must be base64-encoded JPEG");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new HttpError(400, "Image must be a JPEG");
  }
  const size = frameSize(bytes);
  if (!size) throw new HttpError(400, "Malformed JPEG");
  if (size.width < 1 || size.height < 1 || size.width > max || size.height > max) {
    throw new HttpError(400, `Image must be at most ${max}×${max} pixels`);
  }
  return size;
}

/** Walks the marker segments to the first start-of-frame and reads its size. */
function frameSize(bytes: Buffer): { width: number; height: number } | null {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    // Fill bytes and markers without a length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = bytes.readUInt16BE(at + 2);
    if (length < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      if (at + 9 > bytes.length) return null;
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    // Start of scan before any frame header: not a valid image.
    if (marker === 0xda) return null;
    at += 2 + length;
  }
  return null;
}
