import { SCRIBE_REALTIME_URL, type SttSession } from "@mew/shared";
import { z } from "zod";

export type ScribeHandlers = {
  onOpen(): void;
  onPartial(text: string): void;
  /** A finished utterance (the server's VAD detected the end of speech). */
  onCommitted(text: string): void;
  onError(message: string): void;
  onClose(): void;
};

export type ScribeOptions = {
  /**
   * How utterances end: "vad" when the server hears silence (the notebook), "manual" when the
   * client calls `commit()` (hold-to-talk: the key is released).
   */
  commitStrategy?: "vad" | "manual";
  /** Silence that ends an utterance (VAD only). The brief asks for ~700 ms. */
  vadSilenceSecs?: number;
  /** ISO language code; omitted = automatic detection. */
  languageCode?: string;
};

const SAMPLE_RATE = 16000;
/** Audio queued while the socket opens (≈ 3 s of 100 ms chunks); older chunks are dropped. */
const MAX_QUEUED_CHUNKS = 30;

const ServerMessage = z.discriminatedUnion("message_type", [
  z.object({ message_type: z.literal("session_started") }),
  z.object({ message_type: z.literal("partial_transcript"), text: z.string() }),
  z.object({ message_type: z.literal("committed_transcript"), text: z.string() }),
  z.object({ message_type: z.literal("warning"), warning: z.string() }),
]);

const ErrorMessage = z.object({ message_type: z.string(), error: z.string() });

/**
 * Minimal client for ElevenLabs realtime Scribe over a WebSocket. Authenticates with a single-use
 * token minted by our server; the API key never reaches the browser.
 */
export class ScribeClient {
  private readonly socket: WebSocket;
  private readonly queue: string[] = [];

  constructor(session: SttSession, handlers: ScribeHandlers, options: ScribeOptions) {
    // Defence in depth: never stream microphone audio anywhere but the expected host.
    if (session.url !== SCRIBE_REALTIME_URL) throw new Error("Unexpected speech-to-text endpoint");
    const url = new URL(session.url);
    url.searchParams.set("model_id", session.modelId);
    url.searchParams.set("token", session.token);
    url.searchParams.set("audio_format", "pcm_16000");
    const strategy = options.commitStrategy ?? "vad";
    url.searchParams.set("commit_strategy", strategy);
    if (strategy === "vad" && options.vadSilenceSecs !== undefined) {
      url.searchParams.set("vad_silence_threshold_secs", String(options.vadSilenceSecs));
    }
    if (options.languageCode) url.searchParams.set("language_code", options.languageCode);

    this.socket = new WebSocket(url);
    this.socket.onopen = () => {
      for (const message of this.queue.splice(0)) this.socket.send(message);
      handlers.onOpen();
    };
    this.socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      this.dispatch(event.data, handlers);
    };
    this.socket.onerror = () => handlers.onError("Couldn't connect to listening. Try again.");
    this.socket.onclose = () => handlers.onClose();
  }

  sendAudio(pcm: Int16Array): void {
    this.send(pcm, false);
  }

  /**
   * Ends the utterance now (manual commit strategy): the server answers with the committed
   * transcript. Sends a short chunk of silence, since every message carries audio.
   */
  commit(): void {
    this.send(new Int16Array(SAMPLE_RATE / 10), true);
  }

  private send(pcm: Int16Array, commit: boolean): void {
    const message = JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: toBase64(pcm),
      commit,
      sample_rate: SAMPLE_RATE,
    });
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(message);
    } else if (this.socket.readyState === WebSocket.CONNECTING) {
      this.queue.push(message);
      if (this.queue.length > MAX_QUEUED_CHUNKS) this.queue.shift();
    }
  }

  close(): void {
    this.socket.onclose = null;
    this.socket.close(1000);
  }

  private dispatch(raw: string, handlers: ScribeHandlers): void {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const message = ServerMessage.safeParse(data);
    if (message.success) {
      const m = message.data;
      if (m.message_type === "partial_transcript") handlers.onPartial(m.text);
      else if (m.message_type === "committed_transcript") {
        if (m.text.trim()) handlers.onCommitted(m.text.trim());
      } else if (m.message_type === "warning") console.warn("[stt]", m.warning);
      return;
    }
    const error = ErrorMessage.safeParse(data);
    if (error.success) handlers.onError(describeError(error.data.message_type));
  }
}

function describeError(type: string): string {
  switch (type) {
    case "auth_error":
      return "Speech-to-text rejected the session";
    case "quota_exceeded":
    case "rate_limited":
      return "Speech-to-text quota reached";
    case "session_time_limit_exceeded":
      return "Speech-to-text session ended";
    default:
      return "Listening stopped. Try again.";
  }
}

/** Base64 of the PCM bytes (little-endian, as produced by Int16Array on all supported hosts). */
export function toBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}
