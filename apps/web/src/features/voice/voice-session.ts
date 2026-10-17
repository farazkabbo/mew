import { SttSession } from "@mew/shared";

import { type MicrophoneHandle, MicrophoneStartError, startMicrophone } from "./microphone";
import { ScribeClient } from "./scribe-client";
import { useVoice } from "./store";

export type VoiceCallbacks = {
  /** A finished utterance. */
  onUtterance(text: string): void;
  /** The student is speaking (partial transcript) — used for pen-pause and barge-in logic. */
  onSpeech(partial: string): void;
};

/** Silence that ends an utterance (seconds). */
const VAD_SILENCE_SECS = 0.7;

/**
 * One listening session: mints a speech-to-text token on our server, opens the microphone and
 * streams it to Scribe. All state is published to the `useVoice` store.
 */
export class VoiceSession {
  private mic: MicrophoneHandle | null = null;
  private scribe: ScribeClient | null = null;
  private stopped = false;

  constructor(private readonly callbacks: VoiceCallbacks) {}

  async start(): Promise<void> {
    const voice = useVoice.getState();
    voice.setStatus("connecting");
    try {
      const session = await fetchSession();
      if (this.stopped) return;
      this.scribe = new ScribeClient(
        session,
        {
          onOpen: () => !this.stopped && useVoice.getState().setStatus("listening"),
          onPartial: (text) => {
            useVoice.getState().setPartial(text);
            if (text.trim()) this.callbacks.onSpeech(text);
          },
          onCommitted: (text) => {
            useVoice.getState().commit(text);
            this.callbacks.onUtterance(text);
          },
          onError: (message) => this.fail(message),
          onClose: () => !this.stopped && this.fail("Speech-to-text disconnected"),
        },
        { vadSilenceSecs: VAD_SILENCE_SECS },
      );
      this.mic = await startMicrophone((pcm, level) => {
        this.scribe?.sendAudio(pcm);
        useVoice.getState().setLevel(level);
      });
      if (this.stopped) this.release();
    } catch (error) {
      this.fail(describe(error));
    }
  }

  stop(): void {
    this.stopped = true;
    this.release();
    useVoice.getState().setStatus("muted");
  }

  private fail(message: string): void {
    this.stopped = true;
    this.release();
    useVoice.getState().setStatus("error", message);
  }

  private release(): void {
    this.mic?.stop();
    this.mic = null;
    this.scribe?.close();
    this.scribe = null;
  }
}

async function fetchSession(): Promise<SttSession> {
  const response = await fetch("/api/stt/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    cache: "no-store",
  });
  if (!response.ok) throw new SessionError(response.status);
  return SttSession.parse(await response.json());
}

class SessionError extends Error {
  constructor(readonly status: number) {
    super(`Token request failed (${status})`);
  }
}

function describe(error: unknown): string {
  if (error instanceof MicrophoneStartError) {
    return error.reason === "denied"
      ? "Microphone access is blocked. Allow it in the browser's site settings."
      : "No microphone found.";
  }
  if (error instanceof SessionError) {
    if (error.status === 503) return "Speech-to-text isn't configured (ELEVENLABS_API_KEY).";
    if (error.status === 429) return "Too many voice sessions. Try again in a minute.";
    if (error.status === 401) return "Sign in to use voice.";
    return "Couldn't start speech-to-text.";
  }
  return "Couldn't start listening.";
}
