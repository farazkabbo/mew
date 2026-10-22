import {
  enforceMewRules,
  MEW_FEATURES_VERSION,
  type MewDecisionResponse as Decision,
  type MewInput,
  MewLabel,
  mewFeatureText,
  prefilterMew,
} from "@mew/shared";

import type { MewGate } from "./gate";

export type LocalVerdict = { label: MewLabel; score: number; ms: number };

/** The on-device classifier: a verdict, or null when it can't answer (no model, slow, error). */
export interface LocalClassifier {
  /** The least confidence at which its answer is used (tuned when the model was trained). */
  readonly minConfidence: number;
  classify(text: string): Promise<LocalVerdict | null>;
}

/**
 * Mew v2 (brief §4): the shared rules first, then the in-browser model, and the v1 gate (the
 * server's model) whenever the local one isn't sure enough or isn't available.
 */
export class CascadeMewGate implements MewGate {
  constructor(
    private readonly local: LocalClassifier,
    private readonly fallback: MewGate,
    private readonly hooks: { onLocalDecision?(input: MewInput, decision: Decision): void } = {},
    private readonly now: () => number = () => performance.now(),
  ) {}

  async decide(input: MewInput): Promise<Decision> {
    const rule = prefilterMew(input);
    if (rule) return { output: rule, source: "rule", latencyMs: 0 };

    const started = this.now();
    const verdict = await this.local.classify(mewFeatureText(input)).catch(() => null);
    if (verdict && verdict.score >= this.local.minConfidence) {
      const decision: Decision = {
        output: enforceMewRules(input, {
          label: verdict.label,
          confidence: Math.min(1, Math.max(0, verdict.score)),
          reason: "on-device model",
        }),
        source: "local",
        latencyMs: Math.round(this.now() - started),
      };
      this.hooks.onLocalDecision?.(input, decision);
      return decision;
    }
    return this.fallback.decide(input);
  }
}

type Pending = {
  resolve(verdict: LocalVerdict | null): void;
  timer: ReturnType<typeof setTimeout>;
};

/** Answers slower than this go to the v1 gate instead (brief: v2 decides in < 30 ms). */
const CLASSIFY_TIMEOUT_MS = 250;
/** Loading the model the first time (download + compile) may take a while. */
const LOAD_TIMEOUT_MS = 30_000;

/**
 * The classifier in a Web Worker (public/workers/mew-gate.mjs), started on first use. If the
 * model isn't there (the usual case until one is trained), it says so once and stays out of
 * the way: every call answers null at once.
 */
export class WorkerClassifier implements LocalClassifier {
  minConfidence = 1;
  private worker: Worker | null = null;
  private state: "idle" | "loading" | "ready" | "unavailable" = "idle";
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private ready: Promise<boolean> | null = null;

  constructor(private readonly createWorker: () => Worker = defaultWorker) {}

  get status(): string {
    return this.state;
  }

  /** Starts loading the model in the background (call early: loading takes seconds). */
  warm(): Promise<boolean> {
    return this.start();
  }

  async classify(text: string): Promise<LocalVerdict | null> {
    // Never make the student wait for the model to load: v1 decides until it's ready.
    if (this.state !== "ready") {
      if (this.state === "idle") void this.start();
      return null;
    }
    const worker = this.worker;
    if (!worker) return null;
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, CLASSIFY_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      worker.postMessage({ id, text });
    });
  }

  private start(): Promise<boolean> {
    this.ready ??= new Promise<boolean>((resolve) => {
      let worker: Worker;
      try {
        worker = this.createWorker();
      } catch {
        this.state = "unavailable";
        resolve(false);
        return;
      }
      this.worker = worker;
      this.state = "loading";
      const giveUp = setTimeout(() => this.disable(resolve), LOAD_TIMEOUT_MS);
      worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
        const data = event.data;
        if (data.type === "ready") {
          clearTimeout(giveUp);
          this.minConfidence = typeof data.minConfidence === "number" ? data.minConfidence : 1;
          this.state = "ready";
          resolve(true);
        } else if (data.type === "unavailable") {
          clearTimeout(giveUp);
          this.disable(resolve);
        } else {
          this.answer(data);
        }
      };
      worker.onerror = () => {
        clearTimeout(giveUp);
        this.disable(resolve);
      };
      worker.postMessage({ type: "init", features: MEW_FEATURES_VERSION });
    });
    return this.ready;
  }

  private answer(data: Record<string, unknown>): void {
    const pending = this.pending.get(Number(data.id));
    if (!pending) return;
    this.pending.delete(Number(data.id));
    clearTimeout(pending.timer);
    const label = MewLabel.safeParse(data.label);
    const score = Number(data.score);
    pending.resolve(
      label.success && Number.isFinite(score)
        ? { label: label.data, score, ms: Number(data.ms) || 0 }
        : null,
    );
  }

  private disable(resolve: (ok: boolean) => void): void {
    this.state = "unavailable";
    this.worker?.terminate();
    this.worker = null;
    resolve(false);
  }
}

function defaultWorker(): Worker {
  return new Worker("/workers/mew-gate.mjs", { type: "module", name: "mew-gate" });
}
