import { describe, expect, it, vi } from "vitest";

import type { GenerateStructured, InputPart } from "./gemini";
import { recognizeHandwriting, recognizeHandwritingBatch, recognizeLine } from "./recognition";

vi.stubEnv("GEMINI_API_KEY", "test-key");

function answering(output: unknown) {
  const calls: { input: InputPart[] }[] = [];
  const generate = (async (request) => {
    calls.push({ input: request.input as InputPart[] });
    return output;
  }) as GenerateStructured;
  return { generate, calls };
}

const line = (n: number, text: string, confidence = 0.9) => ({
  line: n,
  text,
  latex: null,
  subject: "biology" as const,
  confidence,
});

describe("recognizeHandwritingBatch", () => {
  it("labels each image and puts the answers back in order", async () => {
    const { generate, calls } = answering({ lines: [line(2, "second"), line(1, "first")] });

    const results = await recognizeHandwritingBatch(["png-a", "png-b"], generate);

    expect(results.map((r) => r?.text)).toEqual(["first", "second"]);
    const parts = calls[0]?.input ?? [];
    expect(parts.slice(1).map((p) => (p.type === "text" ? p.text : p.base64))).toEqual([
      "Line 1",
      "png-a",
      "Line 2",
      "png-b",
    ]);
  });

  it("returns null for a line the model left out, and ignores labels that don't exist", async () => {
    const { generate } = answering({ lines: [line(1, "only one"), line(7, "made up")] });

    expect(await recognizeHandwritingBatch(["a", "b"], generate)).toEqual([
      expect.objectContaining({ text: "only one" }),
      null,
    ]);
  });

  it("trusts neither answer when a label comes back twice", async () => {
    const { generate } = answering({ lines: [line(1, "one"), line(1, "other")] });

    const [result] = await recognizeHandwritingBatch(["a"], generate);

    expect(result?.confidence).toBe(0);
  });

  it("never reports a blank transcription as sure", async () => {
    const { generate } = answering({ lines: [line(1, "  ", 0.95)] });

    expect((await recognizeHandwritingBatch(["a"], generate))[0]?.confidence).toBe(0);
  });
});

describe("recognizeHandwriting", () => {
  it("never reports a blank transcription as sure", async () => {
    const { generate } = answering({ text: "", latex: null, subject: "other", confidence: 1 });

    expect((await recognizeHandwriting("a", generate)).confidence).toBe(0);
  });
});

describe("recognizeLine (K10)", () => {
  const context = {
    previous: ["3x + 7 = 19"],
    problem: "Solve 3x + 7 = 19",
    subject: "math" as const,
    vocabulary: ["Algebra"],
  };
  const sympy = (correct: string) => (steps: string[]) =>
    Promise.resolve(
      steps.map((line, index) => ({
        index,
        verdict: line === correct ? ("correct" as const) : ("incorrect" as const),
        reason: "checked",
        detail: null,
      })),
    );

  it("sends the student's examples, the context, then the line; logic picks the reading", async () => {
    const { generate, calls } = answering({
      readings: [
        { text: "3x = 17", latex: "3x = 17", confidence: 0.6 },
        { text: "3x = 12", latex: "3x = 12", confidence: 0.55 },
      ],
      subject: "math",
    });

    const result = await recognizeLine(
      "line-png",
      { context, examples: [{ image: "seven-png", text: "7" }], note: '- "7" can look like "1".' },
      { generate, checkMath: sympy("3x = 12") },
    );

    expect(result).toMatchObject({ text: "3x = 12", chosenBy: "math", confidence: 0.55 });
    expect(result.alternatives?.map((a) => a.text)).toEqual(["3x = 17"]);
    const parts = (calls[0]?.input ?? []).map((p) => (p.type === "text" ? p.text : p.base64));
    expect(parts[0]).toBe('Example: this student wrote "7"');
    expect(parts[1]).toBe("seven-png");
    expect(parts[2]).toContain('"previous":["3x + 7 = 19"]');
    expect(parts[2]).toContain("can look like");
    expect(parts.slice(-2)).toEqual(["Read this line.", "line-png"]);
  });

  it("works without a profile or context", async () => {
    const { generate, calls } = answering({
      readings: [{ text: "hello", latex: null, confidence: 0.9 }],
      subject: "language",
    });
    const result = await recognizeLine("png", {}, { generate, checkMath: sympy("") });
    expect(result).toMatchObject({ text: "hello", subject: "language", chosenBy: "model" });
    expect(calls[0]?.input).toHaveLength(3);
  });
});
