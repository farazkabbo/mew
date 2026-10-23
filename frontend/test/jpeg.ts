/** Test helper: a minimal JPEG header (start of image, an APP0 segment, a baseline frame). */
export function jpegBase64(width: number, height: number): string {
  const bytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08];
  bytes.push(height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00);
  return Buffer.from(bytes).toString("base64");
}
