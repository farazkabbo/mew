export type MicrophoneHandle = { stop(): void };

export type MicrophoneError = "denied" | "unavailable";

export class MicrophoneStartError extends Error {
  constructor(readonly reason: MicrophoneError) {
    super(reason === "denied" ? "Microphone access was blocked" : "No microphone available");
    this.name = "MicrophoneStartError";
  }
}

/**
 * Captures the microphone as 16 kHz 16-bit PCM in 100 ms chunks (via an AudioWorklet), with the
 * browser's echo cancellation and noise suppression on. `level` is the chunk's RMS (0–1).
 */
export async function startMicrophone(
  onChunk: (pcm: Int16Array, level: number) => void,
): Promise<MicrophoneHandle> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    const denied = error instanceof DOMException && error.name === "NotAllowedError";
    throw new MicrophoneStartError(denied ? "denied" : "unavailable");
  }

  const context = new AudioContext();
  try {
    await context.audioWorklet.addModule("/worklets/pcm-recorder.js");
  } catch (error) {
    stream.getTracks().forEach((t) => t.stop());
    await context.close();
    throw error;
  }

  const source = context.createMediaStreamSource(stream);
  const recorder = new AudioWorkletNode(context, "pcm-recorder");
  // A silent sink keeps the graph pulled without playing the mic back (no echo).
  const sink = context.createGain();
  sink.gain.value = 0;
  recorder.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
    onChunk(new Int16Array(event.data.pcm), event.data.level);
  };
  source.connect(recorder).connect(sink).connect(context.destination);

  return {
    stop() {
      recorder.port.onmessage = null;
      source.disconnect();
      recorder.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void context.close();
    },
  };
}
