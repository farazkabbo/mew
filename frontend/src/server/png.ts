import "server-only";

import { TUTOR_LIMITS } from "@mew/shared";

import { HttpError } from "./http-error";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Checks that client-supplied base64 really is a PNG of sane dimensions before it is forwarded
 * to a model: anything else (other formats, huge images, junk) is rejected with 400.
 */
export function assertPng(base64: string): { width: number; height: number } {
  if (!BASE64.test(base64)) throw new HttpError(400, "Image must be base64-encoded PNG");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 24 || !SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw new HttpError(400, "Image must be a PNG");
  }
  // The first chunk must be IHDR: 4-byte length, "IHDR", then width and height (big-endian).
  if (bytes.toString("ascii", 12, 16) !== "IHDR") throw new HttpError(400, "Malformed PNG");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const max = TUTOR_LIMITS.imagePixelsPerSide;
  if (width < 1 || height < 1 || width > max || height > max) {
    throw new HttpError(400, `Image must be at most ${max}×${max} pixels`);
  }
  return { width, height };
}
