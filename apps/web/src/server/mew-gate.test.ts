import { MewInput, type MewOutput } from "@mew/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GenerateStructured } from "./gemini";
import { classifyMew } from "./mew-gate";

function input(overrides: Partial<MewInput> = {}): MewInput {
  return MewInput.parse({
    trigger: "utterance",
    lastUtterance: "why does the force cancel out?",
    recentTranscript: [],
    notebookSignals: { msSinceLastStroke: 4000, justErased: false, linesWrittenLast60s: 2 },
    tutorSpokeRecently: false,
    explicitSummon: false,
    ...overrides,
  });
}

function modelReturning(output: MewOutput | Error) {
  const fn = vi.fn(() =>
    output instanceof Error ? Promise.reject(output) : Promise.resolve(output),
  );
  return fn as unknown as GenerateStructured & typeof fn;
}

describe("classifyMew", () => {
  beforeEach(() => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("decides filler by rule, without calling the model", async () => {
    const model = modelReturning({ label: "answer_question", confidence: 1, reason: "" });
    const decision = await classifyMew(input({ lastUtterance: "hmm okay" }), model);

    expect(decision).toMatchObject({ source: "rule", output: { label: "ignore" } });
    expect(model).not.toHaveBeenCalled();
  });

  it("asks the gate model with minimal thinking and the versioned prompt", async () => {
    const model = modelReturning({
      label: "answer_question",
      confidence: 0.92,
      reason: "direct question",
    });
    const decision = await classifyMew(input(), model);

    expect(decision).toMatchObject({ source: "model", output: { label: "answer_question" } });
    const call = model.mock.calls[0] as unknown as [
      { thinkingLevel: string; model: string; input: string },
    ];
    expect(call[0].thinkingLevel).toBe("minimal");
    expect(call[0].model).toBe("gemini-3.5-flash-lite");
    expect(call[0].input).toContain("why does the force cancel out?");
  });

  it("never lets a summon be ignored", async () => {
    const model = modelReturning({ label: "ignore", confidence: 0.9, reason: "unclear" });
    const decision = await classifyMew(input({ explicitSummon: true, trigger: "summon" }), model);

    expect(decision.output.label).toBe("answer_question");
  });

  it("degrades to silence when the model fails", async () => {
    const decision = await classifyMew(input(), modelReturning(new Error("timeout")));

    expect(decision).toMatchObject({ source: "fallback", output: { label: "ignore" } });
  });

  it("degrades to silence when Gemini is not configured", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.resetModules();
    const { classifyMew: fresh } = await import("./mew-gate");
    const decision = await fresh(
      input(),
      modelReturning({ label: "give_hint", confidence: 1, reason: "" }),
    );

    expect(decision.source).toBe("fallback");
  });
});
