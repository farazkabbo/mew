// Pure audio helpers shared by the PCM recorder worklet and its unit tests.

/**
 * Returns a stateful resampler from `inputRate` to a lower `outputRate`. Each output sample is
 * the average of the input samples it covers (a box filter), which suppresses aliasing well
 * enough for speech recognition. State carries across calls, so blocks can be any size.
 */
export function createResampler(inputRate, outputRate) {
  if (outputRate > inputRate) throw new Error("Upsampling is not supported");
  const ratio = inputRate / outputRate;
  let position = 0;
  let sum = 0;
  let count = 0;
  return function resample(input) {
    const out = new Float32Array(Math.ceil((input.length + position) / ratio) + 1);
    let written = 0;
    for (let i = 0; i < input.length; i++) {
      sum += input[i];
      count++;
      position++;
      if (position >= ratio) {
        out[written++] = sum / count;
        sum = 0;
        count = 0;
        position -= ratio;
      }
    }
    return out.subarray(0, written);
  };
}

/** Float samples in [-1, 1] to signed 16-bit little-endian PCM (clipped). */
export function floatTo16BitPcm(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Root-mean-square level of a block, 0–1. */
export function rms(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
