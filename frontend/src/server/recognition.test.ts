import { describe, expect, it, vi } from "vitest";

import type { GenerateStructured, InputPart } from "./gemini";
import { recognizeHandwriting, recognizeHandwritingBatch } from "./recognition";

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
