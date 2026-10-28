import type { GreyImage } from "./raster";

/** zlib-wrapped deflate (Node: `zlib.deflateSync`; browsers: `CompressionStream("deflate")`). */
export type Deflate = (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** An 8-bit greyscale PNG of the image. */
export async function encodePng(image: GreyImage, deflate: Deflate): Promise<Uint8Array> {
  const { width, height, pixels } = image;
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", await deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * zlib "stored" (uncompressed) blocks: no compression library needed. Bigger files, same image;
 * used by tests and wherever no deflate is at hand.
 */
export const storedDeflate: Deflate = (bytes) => {
  const blocks = Math.max(1, Math.ceil(bytes.length / 0xffff));
  const out = new Uint8Array(2 + blocks * 5 + bytes.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const part = bytes.subarray(b * 0xffff, (b + 1) * 0xffff);
    out[o] = b === blocks - 1 ? 1 : 0;
    out[o + 1] = part.length & 0xff;
    out[o + 2] = part.length >>> 8;
    out[o + 3] = ~part.length & 0xff;
    out[o + 4] = (~part.length >>> 8) & 0xff;
    out.set(part, o + 5);
    o += 5 + part.length;
  }
  let a = 1;
  let c = 0;
  for (const v of bytes) {
    a = (a + v) % 65521;
    c = (c + a) % 65521;
  }
  new DataView(out.buffer).setUint32(o, ((c << 16) | a) >>> 0);
  return out;
};

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

let table: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = (table[(crc ^ b) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 (no data: prefix) of bytes, for JSON request bodies. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET.charAt((n >> 18) & 63);
    out += ALPHABET.charAt((n >> 12) & 63);
    out += b === undefined ? "=" : ALPHABET.charAt((n >> 6) & 63);
    out += c === undefined ? "=" : ALPHABET.charAt(n & 63);
  }
  return out;
}
