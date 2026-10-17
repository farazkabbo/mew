import {
  detectWakePhrase,
  isNewQuestion,
  MEW_COOLDOWN_MS,
  type MewTrigger,
  PEN_PAUSE_MS,
} from "@mew/shared";

export type Evaluation = { trigger: MewTrigger; utterance: string };

export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const browserClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

export type TriggerOptions = {
  penPauseMs: number;
  cooldownMs: number;
  /** Strokes needed since the last pen-pause check before another one (avoids a call per dot). */
  minStrokesForPause: number;
};

const DEFAULTS: TriggerOptions = {
  penPauseMs: PEN_PAUSE_MS,
  cooldownMs: MEW_COOLDOWN_MS,
  minStrokesForPause: 3,
};

/**
 * Decides WHEN to consult the gate (never what it decides):
 * - a finished utterance — or a summon if it contains "Hey Mew";
 * - a pen pause: stillness after writing, with no speech in the meantime;
 * - tapping the mascot.
 * In the cooldown after the tutor speaks, only new questions and summons get through.
 */
export class MewTriggers {
  private readonly opts: TriggerOptions;
  private penTimer: unknown = null;
  private strokesSincePause = 0;
  private tutorFinishedAt: number | null = null;

  constructor(
    private readonly evaluate: (evaluation: Evaluation) => void,
    private readonly clock: Clock = browserClock,
    options: Partial<TriggerOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...options };
  }

  utterance(text: string): void {
    this.cancelPenPause();
    const wake = detectWakePhrase(text);
    if (wake.summoned) {
      this.evaluate({ trigger: "summon", utterance: wake.request });
      return;
    }
    if (this.inCooldown() && !isNewQuestion(text)) return;
    this.evaluate({ trigger: "utterance", utterance: text });
  }

  /** The student is talking: a pen pause during speech isn't a pause. */
  speech(): void {
    this.cancelPenPause();
  }

  strokeAdded(): void {
    this.cancelPenPause();
    this.strokesSincePause++;
    if (this.strokesSincePause < this.opts.minStrokesForPause) return;
    this.penTimer = this.clock.setTimeout(() => {
      this.penTimer = null;
      if (this.inCooldown()) return;
      this.strokesSincePause = 0;
      this.evaluate({ trigger: "pen_pause", utterance: "" });
    }, this.opts.penPauseMs);
  }

  summon(lastUtterance: string): void {
    this.cancelPenPause();
    this.evaluate({ trigger: "summon", utterance: lastUtterance });
  }

  tutorFinished(): void {
    this.tutorFinishedAt = this.clock.now();
  }

  dispose(): void {
    this.cancelPenPause();
  }

  private inCooldown(): boolean {
    return (
      this.tutorFinishedAt !== null &&
      this.clock.now() - this.tutorFinishedAt < this.opts.cooldownMs
    );
  }

  private cancelPenPause(): void {
    if (this.penTimer !== null) this.clock.clearTimeout(this.penTimer);
    this.penTimer = null;
  }
}
