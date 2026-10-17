import { Pcm16Decoder } from "./pcm";

/** Schedule audio in blocks of at least this long (s) to avoid hundreds of tiny buffers. */
const MIN_BLOCK_SECONDS = 0.05;
/** Lead time before the first block plays, absorbing network jitter (s). */
const START_DELAY_SECONDS = 0.06;

type PlayOptions = { sampleRate: number; onStart?: () => void; signal?: AbortSignal };

/**
 * Plays streamed PCM speech gaplessly through Web Audio as it arrives, and can fade it out
 * quickly when the student interrupts (barge-in).
 */
export class PcmStreamPlayer {
  private context: AudioContext | null = null;
  private output: GainNode | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private finish: (() => void) | null = null;

  /** Call from a user gesture (click, mic start) so later playback isn't blocked by autoplay rules. */
  unlock(): void {
    const context = this.ensureContext();
    if (context.state === "suspended") void context.resume();
  }

  /** Plays the stream; resolves when playback ends, is stopped, or the signal aborts. */
  async play(stream: ReadableStream<Uint8Array>, { sampleRate, onStart, signal }: PlayOptions) {
    const context = this.ensureContext();
    if (context.state === "suspended") await context.resume().catch(() => undefined);
    this.output = new GainNode(context, { gain: 1 });
    this.output.connect(context.destination);
    this.nextTime = 0;

    const done = new Promise<void>((resolve) => (this.finish = resolve));
    const decoder = new Pcm16Decoder();
    const reader = stream.getReader();
    const minSamples = Math.round(sampleRate * MIN_BLOCK_SECONDS);
    let pending: Float32Array[] = [];
    let pendingLength = 0;
    let started = false;

    const flush = () => {
      if (pendingLength === 0 || !this.output) return;
      const buffer = context.createBuffer(1, pendingLength, sampleRate);
      let offset = 0;
      for (const block of pending) {
        buffer.copyToChannel(block as Float32Array<ArrayBuffer>, 0, offset);
        offset += block.length;
      }
      pending = [];
      pendingLength = 0;
      this.schedule(buffer);
      if (!started) {
        started = true;
        onStart?.();
      }
    };

    const onAbort = () => this.stop();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended || !this.output) break;
        const samples = decoder.decode(value);
        pending.push(samples);
        pendingLength += samples.length;
        if (pendingLength >= minSamples) flush();
      }
      flush();
      if (this.sources.size === 0) this.complete();
    } catch {
      this.stop();
    } finally {
      signal?.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
    return done;
  }

  /** Fades out over `fadeMs` and stops everything that's playing or scheduled. */
  stop(fadeMs = 150): void {
    const { context, output } = this;
    if (context && output) {
      const now = context.currentTime;
      output.gain.cancelScheduledValues(now);
      output.gain.setValueAtTime(output.gain.value, now);
      output.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
      for (const source of this.sources) source.stop(now + fadeMs / 1000);
    }
    this.sources.clear();
    this.output = null;
    this.complete();
  }

  private schedule(buffer: AudioBuffer): void {
    const context = this.context;
    if (!context || !this.output) return;
    const source = new AudioBufferSourceNode(context, { buffer });
    source.connect(this.output);
    const at = Math.max(this.nextTime, context.currentTime + START_DELAY_SECONDS);
    source.start(at);
    this.nextTime = at + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0 && this.output) this.complete();
    };
  }

  private complete(): void {
    this.finish?.();
    this.finish = null;
  }

  private ensureContext(): AudioContext {
    this.context ??= new AudioContext();
    return this.context;
  }
}
