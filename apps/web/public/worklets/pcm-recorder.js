// AudioWorklet that turns microphone audio into 16 kHz mono 16-bit PCM chunks of 100 ms,
// the format the realtime speech-to-text socket expects. Runs on the audio rendering thread.
import { createResampler, floatTo16BitPcm, rms } from "./pcm-encoder.js";

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = TARGET_RATE / 10;

class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is the AudioContext's rate, a global in the worklet scope.
    this.resample = createResampler(sampleRate, TARGET_RATE);
    this.chunk = new Int16Array(CHUNK_SAMPLES);
    this.filled = 0;
    this.levelSum = 0;
    this.levelBlocks = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    this.levelSum += rms(channel);
    this.levelBlocks++;
    const pcm = floatTo16BitPcm(this.resample(channel));
    for (let i = 0; i < pcm.length; i++) {
      this.chunk[this.filled++] = pcm[i];
      if (this.filled === CHUNK_SAMPLES) this.flush();
    }
    return true;
  }

  flush() {
    const level = this.levelBlocks ? this.levelSum / this.levelBlocks : 0;
    const buffer = this.chunk.buffer;
    this.port.postMessage({ pcm: buffer, level }, [buffer]);
    this.chunk = new Int16Array(CHUNK_SAMPLES);
    this.filled = 0;
    this.levelSum = 0;
    this.levelBlocks = 0;
  }
}

registerProcessor("pcm-recorder", PcmRecorder);
