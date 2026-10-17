import { describe, expect, it } from "vitest";

// The worklet helpers are plain JS served from /public; they're tested directly.
import { createResampler, floatTo16BitPcm, rms } from "../../../public/worklets/pcm-encoder.js";
import { toBase64 } from "./scribe-client";

describe("PCM encoding", () => {
  it("downsamples 48 kHz to 16 kHz by averaging groups of three", () => {
    const resample = createResampler(48_000, 16_000);
    const out = resample(Float32Array.from([0.3, 0.3, 0.3, -0.6, -0.6, -0.6, 0, 0.3]));

    expect(Array.from(out).map((v) => Number(v.toFixed(3)))).toEqual([0.3, -0.6]);
  });

  it("carries leftovers across blocks (worklet blocks are 128 samples)", () => {
    const resample = createResampler(44_100, 16_000);
    let total = 0;
    for (let i = 0; i < 1000; i++) total += resample(new Float32Array(128)).length;

    expect(total).toBe(Math.floor((128 * 1000 * 16_000) / 44_100));
  });

  it("refuses to upsample", () => {
    expect(() => createResampler(8_000, 16_000)).toThrow();
  });

  it("clips and scales to 16-bit", () => {
    expect(Array.from(floatTo16BitPcm(Float32Array.from([0, 1, -1, 2, -2, 0.5])))).toEqual([
      0, 32767, -32768, 32767, -32768, 16383,
    ]);
  });

  it("measures level", () => {
    expect(rms(Float32Array.from([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array(0))).toBe(0);
  });

  it("base64-encodes little-endian PCM bytes", () => {
    expect(toBase64(Int16Array.from([1, -1]))).toBe(btoa(String.fromCharCode(1, 0, 255, 255)));
  });
});
