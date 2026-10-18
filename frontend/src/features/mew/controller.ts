import type { PageDocument } from "@mew/ink";
import {
  type LineCheck,
  MEW_LIMITS,
  type MewInput,
  type MewLabel,
  type NotebookSignals,
  shouldRespond,
} from "@mew/shared";

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

/** What Mew needs from the rest of the app. All optional, so the gate works on its own. */
export type MewHooks = {
  /** The gate decided to respond: hand the turn to the tutor. */
  onRespond?(turn: {
    intent: Exclude<MewLabel, "ignore">;
    utterance: string;
    triggeredAt: number;
    gateMs: number;
    /** Verified verdicts that prompted the turn, if a checker found something. */
    checks?: LineCheck[];
  }): void;
  /** Whether the tutor is talking or just finished. */
  tutorSpokeRecently?(): boolean;
  /** Recognised text of the line being written, if known. */
  activeRegionText?(doc: PageDocument): string | undefined;
  /**
   * After a writing pause: verify the line just written (SymPy, chemistry balance, code). A
   * definite verdict short-circuits the gate; null means "can't tell", and the gate decides.
   */
  quickCheck?(doc: PageDocument): Promise<LineCheck[] | null>;
  /** A pause produced a verified-correct line: tick it quietly (no tutor turn). */
  onVerifiedCorrect?(checks: LineCheck[]): void;
};

/** An erase within this window counts as "just erased". */
const JUST_ERASED_MS = 10_000;
const RECENT_LINE_MS = 60_000;

/**
 * Wires the notebook and the voice transcript to the gate: turns activity into triggers, builds
 * the gate input, records each decision, and hands acted-on decisions to the tutor.
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
    private readonly hooks: MewHooks = {},
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

  /** The tutor finished a turn: start the cooldown. */
  tutorFinished(): void {
    this.triggers.tutorFinished();
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
    if (trigger === "pen_pause" && this.page && this.hooks.quickCheck) {
      const checks = await this.hooks.quickCheck(this.page.doc).catch(() => null);
      if (checks && this.verified(checks, input, started)) return;
    }
    const decision = await this.gate.decide(input);
    const gateMs = this.clock.now() - started;
    const acted = shouldRespond(decision.output, {
      threshold: useMew.getState().threshold,
      explicitSummon: input.explicitSummon,
    });
    useMew.getState().record({
      ...decision,
      at: started,
      trigger,
      utterance: input.lastUtterance,
      roundTripMs: gateMs,
      acted,
    });
    const { label } = decision.output;
    if (acted && label !== "ignore") {
      this.hooks.onRespond?.({
        intent: label,
        utterance: input.lastUtterance,
        triggeredAt: started,
        gateMs,
      });
    }
  }

  /**
   * A verifier settled the pause: a correct line is ticked quietly; a wrong one gets the tutor
   * (with the verdict). Recorded like a gate decision so the debug panel shows why.
   */
  private verified(checks: LineCheck[], input: MewInput, started: number): boolean {
    const target = checks.find((c) => c.target);
    if (target?.verdict !== "correct" && target?.verdict !== "incorrect") return false;
    const wrong = target.verdict === "incorrect";
    const gateMs = this.clock.now() - started;
    useMew.getState().record({
      output: {
        label: "check_work",
        confidence: 1,
        reason: `${target.checker} check: ${target.verdict} (${target.reason})`,
      },
      source: "checker",
      latencyMs: Math.round(gateMs),
      at: started,
      trigger: input.trigger,
      utterance: input.lastUtterance,
      roundTripMs: gateMs,
      acted: true,
    });
    if (wrong) {
      this.hooks.onRespond?.({
        intent: "check_work",
        utterance: input.lastUtterance,
        triggeredAt: started,
        gateMs,
        checks,
      });
    } else {
      this.hooks.onVerifiedCorrect?.(checks);
    }
    return true;
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
      tutorSpokeRecently: this.hooks.tutorSpokeRecently?.() ?? false,
      explicitSummon: trigger === "summon",
    };
  }

  private signals(): NotebookSignals {
    const now = this.clock.now();
    const recentLines = this.page
      ? studentLines(this.page.doc).filter((l) => now - l.lastCreatedAt < RECENT_LINE_MS).length
      : 0;
    const regionText = this.page ? this.hooks.activeRegionText?.(this.page.doc) : undefined;
    return {
      msSinceLastStroke: this.lastStrokeAt === null ? null : Math.round(now - this.lastStrokeAt),
      justErased: this.lastEraseAt !== null && now - this.lastEraseAt < JUST_ERASED_MS,
      linesWrittenLast60s: recentLines,
      ...(regionText && { activeRegionText: regionText.slice(0, MEW_LIMITS.regionTextChars) }),
    };
  }
}

function clip(text: string): string {
  return text.length <= MEW_LIMITS.utteranceChars ? text : text.slice(-MEW_LIMITS.utteranceChars);
}
