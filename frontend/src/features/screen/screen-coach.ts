import { TTS_SAMPLE_RATE } from "@mew/shared";

import { askAboutScreen } from "../desktop/bridge";
import { useSettings } from "../settings/store";
import { PcmStreamPlayer } from "../tutor/pcm-player";
import type { ScreenAnswerDetail } from "./events";
import { HoldToTalk } from "./hold-to-talk";

export type ScreenCoachDeps = {
  listener: Pick<HoldToTalk, "start" | "finish" | "cancel">;
  ask: (transcript: string) => Promise<void>;
  speak: (text: string) => Promise<void>;
};

/**
 * The page's part of "ask about your screen": listen while the hotkey is held, send the words to
 * the desktop app when it's released, and say the answer out loud (once: early from the speech
 * event when it comes first, otherwise from the full answer).
 */
export class ScreenCoachVoice {
  private spokeForThisTurn = false;

  constructor(private readonly deps: ScreenCoachDeps = defaultDeps()) {}

  onListen(): void {
    this.spokeForThisTurn = false;
    this.deps.listener.start();
  }

  async onRelease(): Promise<void> {
    const transcript = await this.deps.listener.finish();
    await this.deps.ask(transcript);
  }

  onCancel(): void {
    this.deps.listener.cancel();
  }

  onSpeech(text: string): void {
    if (this.spokeForThisTurn) return;
    this.spokeForThisTurn = true;
    void this.deps.speak(text);
  }

  onAnswer(answer: ScreenAnswerDetail): void {
    if (!this.spokeForThisTurn) void this.deps.speak(answer.response.speech);
    // Ink (answer.response.actions) is drawn by the desktop overlay from S3.
    this.spokeForThisTurn = false;
  }
}

function defaultDeps(): ScreenCoachDeps {
  const player = new PcmStreamPlayer();
  return {
    listener: new HoldToTalk(),
    ask: askAboutScreen,
    speak: async (text) => {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voiceId: useSettings.getState().settings.voice_id }),
        cache: "no-store",
      }).catch(() => null);
      if (!response?.ok || !response.body) return;
      await player.play(response.body, { sampleRate: TTS_SAMPLE_RATE });
    },
  };
}
