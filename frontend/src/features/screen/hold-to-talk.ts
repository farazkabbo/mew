import { SttSession } from "@mew/shared";

import { type MicrophoneHandle, startMicrophone } from "../voice/microphone";
import { useSettings } from "../settings/store";
import { ScribeClient, scribeLanguage } from "../voice/scribe-client";

/** How long to wait for the transcript after the key comes up before using what was heard. */
const COMMIT_TIMEOUT_MS = 2500;

/**
 * Hold-to-talk for Screen Coach: listening starts when the hotkey goes down, and the question is
 * committed the moment it comes up (manual commit), instead of waiting for a pause.
 *
 * Audio goes straight from this page to ElevenLabs with a single-use token, like the notebook's
 * voice; the desktop app only ever receives the finished words.
 */
export class HoldToTalk {
  private mic: MicrophoneHandle | null = null;
  private scribe: ScribeClient | null = null;
  private started: Promise<void> | null = null;
  private heard = "";
  private onCommitted: ((text: string) => void) | null = null;

  /** Starts listening (call when the hotkey goes down). */
  start(): void {
    this.started ??= this.open().catch(() => this.release());
  }

  /** Ends the question (call when the hotkey comes up) and resolves with what was said. */
  async finish(timeoutMs = COMMIT_TIMEOUT_MS): Promise<string> {
    await this.started;
    if (!this.scribe) return "";
    this.mic?.stop();
    this.mic = null;
    const committed = new Promise<string>((resolve) => {
      this.onCommitted = resolve;
      window.setTimeout(() => resolve(this.heard), timeoutMs);
    });
    this.scribe.commit();
    const text = await committed;
    this.release();
    return text.trim();
  }

  /** Stops without asking anything (the capture was refused, or the page is going away). */
  cancel(): void {
    this.release();
  }

  private async open(): Promise<void> {
    this.heard = "";
    const session = await fetchSession();
    this.scribe = new ScribeClient(
      session,
      {
        onOpen: () => undefined,
        onPartial: (text) => {
          if (text.trim()) this.heard = text;
        },
        onCommitted: (text) => {
          // An empty commit never wipes words already heard.
          if (text.trim()) this.heard = text;
          this.onCommitted?.(this.heard);
        },
        onError: () => this.release(),
        onClose: () => undefined,
      },
      {
        commitStrategy: "manual",
        ...scribeLanguage(useSettings.getState().settings.language),
      },
    );
    this.mic = await startMicrophone((pcm) => this.scribe?.sendAudio(pcm));
  }

  private release(): void {
    this.mic?.stop();
    this.mic = null;
    this.scribe?.close();
    this.scribe = null;
    this.started = null;
  }
}

async function fetchSession(): Promise<SttSession> {
  const response = await fetch("/api/stt/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Speech-to-text token request failed (${response.status})`);
  return SttSession.parse(await response.json());
}
