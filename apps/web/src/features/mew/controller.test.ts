import { PageDocument, strokeBBox } from "@mew/ink";
import { MewInput, type MewDecisionResponse, type Point, type Stroke } from "@mew/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PageChange } from "../notebook/engine";
import { useVoice } from "../voice/store";
import { MewController, type ObservedPage } from "./controller";
import type { MewGate } from "./gate";
import { useMew } from "./store";
import type { Clock } from "./triggers";

let now = 1_000_000;
const clock: Clock = { now: () => now, setTimeout: () => 0, clearTimeout: () => undefined };

function gateReturning(decision: MewDecisionResponse) {
  const decide = vi.fn((input: MewInput) => {
    MewInput.parse(input); // the controller must always send a valid request
    return Promise.resolve(decision);
  });
  return { decide } satisfies MewGate;
}

function page(strokes: Stroke[] = []) {
  const listeners = new Set<(c: PageChange) => void>();
  const observed: ObservedPage = {
    doc: new PageDocument(strokes),
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return { observed, emit: (c: PageChange) => listeners.forEach((l) => l(c)) };
}

function stroke(y: number, createdAt: number): Stroke {
  const points: Point[] = [
    [0, y, 0.5, 0],
    [60, y + 12, 0.5, 30],
  ];
  return {
    id: crypto.randomUUID(),
    pageId: crypto.randomUUID(),
    author: "student",
    tool: "pen",
    points,
    color: "#1d1c1a",
    width: 2,
    bbox: strokeBBox(points, 2),
    createdAt,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useMew.setState({ decisions: [], pending: 0, threshold: 0.7 });
  useVoice.setState({ segments: [], partial: "" });
});

describe("MewController", () => {
  it("sends the utterance with prior transcript and notebook signals, and records the decision", async () => {
    const gate = gateReturning({
      output: { label: "answer_question", confidence: 0.92, reason: "direct question" },
      source: "model",
      latencyMs: 210,
    });
    const mew = new MewController(gate, clock);
    const { observed, emit } = page([stroke(100, now - 5000), stroke(200, now - 120_000)]);
    mew.observe(observed);
    emit("draw");
    now += 2000;
    useVoice.getState().commit("so this is the free body diagram");
    useVoice.getState().commit("why does the force cancel out?");

    mew.utterance("why does the force cancel out?");
    await flush();

    const input = gate.decide.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      trigger: "utterance",
      lastUtterance: "why does the force cancel out?",
      recentTranscript: ["so this is the free body diagram"],
      explicitSummon: false,
      notebookSignals: { msSinceLastStroke: 2000, justErased: false, linesWrittenLast60s: 1 },
    });
    expect(useMew.getState().decisions[0]).toMatchObject({ acted: true, trigger: "utterance" });
    expect(useMew.getState().pending).toBe(0);
  });

  it("does not act below the threshold", async () => {
    const gate = gateReturning({
      output: { label: "answer_question", confidence: 0.5, reason: "maybe" },
      source: "model",
      latencyMs: 100,
    });
    const mew = new MewController(gate, clock);

    mew.utterance("I wonder whether it's the normal force");
    await flush();

    expect(useMew.getState().decisions[0]?.acted).toBe(false);
  });

  it("reports recent erasing", async () => {
    const gate = gateReturning({
      output: { label: "ignore", confidence: 1, reason: "" },
      source: "rule",
      latencyMs: 0,
    });
    const mew = new MewController(gate, clock);
    const { observed, emit } = page();
    mew.observe(observed);
    emit("erase");

    mew.utterance("hmm why did that not work");
    await flush();

    expect(gate.decide.mock.calls[0]?.[0].notebookSignals.justErased).toBe(true);
  });

  it("summons with what the student is saying right now", async () => {
    const gate = gateReturning({
      output: { label: "check_work", confidence: 0.4, reason: "summoned" },
      source: "model",
      latencyMs: 100,
    });
    const mew = new MewController(gate, clock);
    useVoice.setState({ partial: "is this step right" });

    mew.summon();
    await flush();

    expect(gate.decide.mock.calls[0]?.[0]).toMatchObject({
      trigger: "summon",
      explicitSummon: true,
      lastUtterance: "is this step right",
    });
    expect(useMew.getState().decisions[0]?.acted).toBe(true); // summons bypass the threshold
  });

  it("clips very long utterances to the request limit", async () => {
    const gate = gateReturning({
      output: { label: "ignore", confidence: 1, reason: "" },
      source: "model",
      latencyMs: 1,
    });
    const mew = new MewController(gate, clock);

    mew.utterance("word ".repeat(400));
    await flush();

    expect(gate.decide.mock.calls[0]?.[0].lastUtterance.length).toBeLessThanOrEqual(500);
  });
});
