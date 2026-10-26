import { TTS_SAMPLE_RATE } from "@mew/shared";

import { askAboutScreen, reportSpoken } from "../desktop/bridge";
import { useSettings } from "../settings/store";
import { PcmStreamPlayer } from "../tutor/pcm-player";
import type { ScreenAnswerDetail } from "./events";
import { collect, type SpokenLines } from "./entry-voice";
import { HoldToTalk } from "./hold-to-talk";

export type ScreenCoachDeps = {
  listener: Pick<HoldToTalk, "start" | "finish" | "cancel">;
  ask: (transcript: string) => Promise<void>;
  /** `keep`: remember how it sounded (a Circle & Ask step: K8 keeps it with its entry). */
  speak: (text: string, keep?: boolean) => Promise<void>;
  /** Stops whatever is being said (the student pressed the hotkey, or newer words came). */
  hush: () => void;
  /** Tells the desktop app a line with a token has been said. */
  spoken: (token: number) => void;
};

/**
 * The page's part of "ask about your screen": listen while the hotkey is held, send the words to
 * the desktop app when it's released, and say the answer out loud (once: early from the speech
 * event when it comes first, otherwise from the full answer). Coach mode's lines (`onSay`) are
 * always said, cutting off anything older; pressing the hotkey cuts off whatever is being said.
 */
export class ScreenCoachVoice {
  private spokeForThisTurn = false;

  constructor(private readonly deps: ScreenCoachDeps = defaultDeps()) {}

  onListen(): void {
    this.spokeForThisTurn = false;
    this.deps.hush();
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

  /**
   * A line from coach mode (S4) or Circle & Ask (S3.2): said now, instead of anything still being
   * said. A Circle & Ask step's `token` is reported once it's been said (even if it couldn't be:
   * the explanation goes on either way).
   */
  onSay(text: string, token?: number): void {
    this.deps.hush();
    const said = this.deps.speak(text, token !== undefined).catch(() => undefined);
    if (token !== undefined) void said.then(() => this.deps.spoken(token));
  }

  /** Stop talking (Circle & Ask: a step skipped, paused or stopped). */
  onHush(): void {
    this.deps.hush();
  }

  onAnswer(answer: ScreenAnswerDetail): void {
    if (!this.spokeForThisTurn) void this.deps.speak(answer.response.speech);
    // Ink (answer.response.actions) is drawn by the desktop overlay from S3.
    this.spokeForThisTurn = false;
  }
}

export function defaultDeps(spoken: SpokenLines | null = null): ScreenCoachDeps {
  const player = new PcmStreamPlayer();
  return {
    listener: new HoldToTalk(),
    ask: askAboutScreen,
    speak: async (text, keep = false) => {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voiceId: useSettings.getState().settings.voice_id }),
        cache: "no-store",
      }).catch(() => null);
      if (!response?.ok || !response.body) return;
      if (!keep || !spoken) {
        await player.play(response.body, { sampleRate: TTS_SAMPLE_RATE });
        return;
      }
      // Played and kept at once: the kept copy goes with the entry when it's saved (K8).
      const [heard, kept] = response.body.tee();
      void collect(kept).then((pcm) => pcm && spoken.remember(text, pcm));
      await player.play(heard, { sampleRate: TTS_SAMPLE_RATE });
    },
    hush: () => player.stop(),
    spoken: (token) => void reportSpoken(token).catch(() => undefined),
  };
}
