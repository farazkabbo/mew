/**
 * Incremental decoder for signed 16-bit little-endian PCM arriving in arbitrary byte chunks
 * (network chunks can split a sample in half; the odd byte is carried to the next chunk).
 */
export class Pcm16Decoder {
  private carry: number | null = null;

  decode(chunk: Uint8Array): Float32Array {
    const bytes = this.carry === null ? chunk : concat(Uint8Array.of(this.carry), chunk);
    const usable = bytes.length - (bytes.length % 2);
    this.carry = usable < bytes.length ? (bytes[usable] ?? null) : null;

    const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
    const out = new Float32Array(usable / 2);
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
    return out;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
