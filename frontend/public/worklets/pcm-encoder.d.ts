export function createResampler(
  inputRate: number,
  outputRate: number,
): (input: Float32Array) => Float32Array;
export function floatTo16BitPcm(samples: Float32Array): Int16Array;
export function rms(samples: Float32Array): number;
