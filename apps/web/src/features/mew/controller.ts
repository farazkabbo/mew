import type { PageDocument } from "@mew/ink";
import { MEW_LIMITS, type MewInput, type NotebookSignals, shouldRespond } from "@mew/shared";

import type { PageChange } from "../notebook/engine";
import { studentLines } from "../notebook/export-line";
import { useVoice } from "../voice/store";
import type { MewGate } from "./gate";
import { useMew } from "./store";
import { type Clock, type Evaluation, MewTriggers } from "./triggers";

/** The page as Mew sees it: its strokes and a feed of edits. */
export type ObservedPage = {
  doc: PageDocument;
  subscribe(listener: (change: PageChange) => void): () => void;
};

/** An erase within this window counts as "just erased". */
const JUST_ERASED_MS = 10_000;
const RECENT_LINE_MS = 60_000;

/**
 * Wires the notebook and the voice transcript to the gate: turns activity into triggers, builds
 * the gate input, and records each decision. In M3 acted-on decisions go to the tutor.
 */
export class MewController {
  private readonly triggers: MewTriggers;
  private page: ObservedPage | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastStrokeAt: number | null = null;
  private lastEraseAt: number | null = null;

  constructor(
    private readonly gate: MewGate,
    private readonly clock: Clock,
  ) {
    this.triggers = new MewTriggers((evaluation) => void this.evaluate(evaluation), clock);
  }

  /** Follows a page (the one on screen); pass null when none is open. */
  observe(page: ObservedPage | null): void {
    this.unsubscribe?.();
    this.page = page;
    this.unsubscribe = page?.subscribe((change) => this.onPageChange(change)) ?? null;
  }

  utterance(text: string): void {
    this.triggers.utterance(text);
  }

  speech(): void {
    this.triggers.speech();
  }

  /** The student tapped the mascot. */
  summon(): void {
    const { partial, segments } = useVoice.getState();
    this.triggers.summon(partial.trim() || segments.at(-1)?.text || "");
  }

  dispose(): void {
    this.observe(null);
    this.triggers.dispose();
  }

  private onPageChange(change: PageChange): void {
    if (change === "draw") {
      this.lastStrokeAt = this.clock.now();
      this.triggers.strokeAdded();
    } else if (change === "erase" || change === "delete") {
      this.lastEraseAt = this.clock.now();
    }
  }

  private async evaluate({ trigger, utterance }: Evaluation): Promise<void> {
    const input = this.buildInput(trigger, utterance);
    const started = this.clock.now();
    const mew = useMew.getState();
    mew.begin();
    const decision = await this.gate.decide(input);
    useMew.getState().record({
      ...decision,
      at: started,
      trigger,
      utterance: input.lastUtterance,
      roundTripMs: this.clock.now() - started,
      acted: shouldRespond(decision.output, {
        threshold: useMew.getState().threshold,
        explicitSummon: input.explicitSummon,
      }),
    });
  }

  private buildInput(trigger: Evaluation["trigger"], utterance: string): MewInput {
    const segments = useVoice.getState().segments;
    // The utterance being evaluated is normally the latest segment; context is what came before.
    const previous = segments.at(-1)?.text === utterance ? segments.slice(0, -1) : segments;
    return {
      trigger,
      lastUtterance: clip(utterance),
      recentTranscript: previous.slice(-MEW_LIMITS.transcriptSegments).map((s) => clip(s.text)),
      notebookSignals: this.signals(),
      tutorSpokeRecently: false, // the tutor speaks from M3
      explicitSummon: trigger === "summon",
    };
  }

  private signals(): NotebookSignals {
    const now = this.clock.now();
    const recentLines = this.page
      ? studentLines(this.page.doc).filter((l) => now - l.lastCreatedAt < RECENT_LINE_MS).length
      : 0;
    return {
      msSinceLastStroke: this.lastStrokeAt === null ? null : Math.round(now - this.lastStrokeAt),
      justErased: this.lastEraseAt !== null && now - this.lastEraseAt < JUST_ERASED_MS,
      linesWrittenLast60s: recentLines,
    };
  }
}

function clip(text: string): string {
  return text.length <= MEW_LIMITS.utteranceChars ? text : text.slice(-MEW_LIMITS.utteranceChars);
}
