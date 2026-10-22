import type { MewDecisionResponse, MewInput } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

import type { MewGate } from "./gate";
import { CascadeMewGate, type LocalClassifier, WorkerClassifier } from "./local-gate";

const input = (lastUtterance: string, extra: Partial<MewInput> = {}): MewInput => ({
  trigger: "utterance",
  lastUtterance,
  recentTranscript: [],
  notebookSignals: { msSinceLastStroke: null, justErased: false, linesWrittenLast60s: 0 },
  tutorSpokeRecently: false,
  explicitSummon: false,
  ...extra,
});

const V1: MewDecisionResponse = {
  output: { label: "answer_question", confidence: 0.9, reason: "server model" },
  source: "model",
  latencyMs: 700,
};

function v1() {
  return { decide: vi.fn<MewGate["decide"]>(() => Promise.resolve(V1)) };
}

function local(verdict: Awaited<ReturnType<LocalClassifier["classify"]>>, minConfidence = 0.85) {
  return { minConfidence, classify: vi.fn(() => Promise.resolve(verdict)) };
}

describe("CascadeMewGate (Mew v2)", () => {
  it("answers on the device when the model is sure, and reports it", async () => {
    const fallback = v1();
    const onLocalDecision = vi.fn();
    const gate = new CascadeMewGate(local({ label: "check_work", score: 0.93, ms: 4 }), fallback, {
      onLocalDecision,
    });

    const decision = await gate.decide(input("is this right?"));

    expect(decision).toMatchObject({
      source: "local",
      output: { label: "check_work", confidence: 0.93, reason: "on-device model" },
    });
    expect(fallback.decide).not.toHaveBeenCalled();
    expect(onLocalDecision).toHaveBeenCalledWith(input("is this right?"), decision);
  });

  it("asks v1 when the model isn't sure or isn't there", async () => {
    for (const classifier of [local({ label: "ignore", score: 0.6, ms: 3 }), local(null)]) {
      const fallback = v1();
      const decision = await new CascadeMewGate(classifier, fallback).decide(
        input("so the derivative of x squared"),
      );
      expect(decision).toBe(V1);
      expect(fallback.decide).toHaveBeenCalledOnce();
    }
  });

  it("keeps the shared rules: filler never reaches a model", async () => {
    const classifier = local({ label: "answer_question", score: 0.99, ms: 1 });
    const decision = await new CascadeMewGate(classifier, v1()).decide(input("hmm"));
    expect(decision.source).toBe("rule");
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it("sends the shared feature text, not the raw input", async () => {
    const classifier = local(null);
    await new CascadeMewGate(classifier, v1()).decide(input("why is it negative?"));
    expect(classifier.classify).toHaveBeenCalledWith(
      "why is it negative? | before: - | writing: - | trigger utterance; summoned no; tutor spoke no; last stroke none; erased no; lines 0",
    );
  });
});

/** A stand-in Web Worker that answers like public/workers/mew-gate.mjs. */
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  constructor(private readonly behaviour: "ready" | "unavailable" | "silent") {}
  postMessage(message: { type?: string; id?: number; text?: string }) {
    queueMicrotask(() => {
      if (message.type === "init") {
        if (this.behaviour === "silent") return;
        this.reply(
          this.behaviour === "ready"
            ? { type: "ready", minConfidence: 0.8 }
            : { type: "unavailable", reason: "no on-device model" },
        );
      } else {
        this.reply({ id: message.id, label: "give_hint", score: 0.88, ms: 5 });
      }
    });
  }
  terminate() {
    this.terminated = true;
  }
  private reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

describe("WorkerClassifier", () => {
  it("never waits for the model: null while it loads, answers once it's ready", async () => {
    const create = vi.fn(() => new FakeWorker("ready") as unknown as Worker);
    const classifier = new WorkerClassifier(create);
    expect(await classifier.classify("I'm stuck")).toBeNull(); // starts loading, v1 decides
    expect(await classifier.warm()).toBe(true);
    expect(await classifier.classify("I'm stuck")).toEqual({
      label: "give_hint",
      score: 0.88,
      ms: 5,
    });
    expect(classifier.minConfidence).toBe(0.8);
    expect(create).toHaveBeenCalledOnce();
  });

  it("without a model it gives up once and then answers null at once", async () => {
    const worker = new FakeWorker("unavailable");
    const create = vi.fn(() => worker as unknown as Worker);
    const classifier = new WorkerClassifier(create);
    expect(await classifier.warm()).toBe(false);
    expect(classifier.status).toBe("unavailable");
    expect(worker.terminated).toBe(true);
    expect(await classifier.classify("again")).toBeNull();
    expect(create).toHaveBeenCalledOnce();
  });

  it("gives up if the model never loads", async () => {
    vi.useFakeTimers();
    try {
      const classifier = new WorkerClassifier(() => new FakeWorker("silent") as unknown as Worker);
      const loading = classifier.warm();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await loading).toBe(false);
      expect(classifier.status).toBe("unavailable");
    } finally {
      vi.useRealTimers();
    }
  });
});
