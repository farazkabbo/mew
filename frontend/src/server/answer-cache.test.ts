import { describe, expect, it, vi } from "vitest";

import { forgetAnswers, reusingAnswers } from "./answer-cache";
import type { StreamStructuredText } from "./gemini";

vi.mock("server-only", () => ({}));

const request = (text: string, image = "AAAA") => ({
  model: "m",
  system: "s",
  input: [
    { type: "text" as const, text },
    { type: "image" as const, base64: image, mimeType: "image/jpeg" as const },
  ],
  thinkingLevel: "low" as const,
  maxOutputTokens: 10,
  timeoutMs: 10,
  schema: undefined as never,
});

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

describe("reusing answers", () => {
  it("answers the same question about the same picture once, and anything else afresh", async () => {
    forgetAnswers();
    const model = vi.fn(async function* () {
      yield '{"a":';
      yield "1}";
    }) as unknown as StreamStructuredText;
    let now = 0;
    const stream = reusingAnswers(model, () => now);

    expect(await collect(stream(request("explain")))).toBe('{"a":1}');
    expect(await collect(stream(request("explain")))).toBe('{"a":1}');
    expect(model).toHaveBeenCalledTimes(1);

    await collect(stream(request("explain", "BBBB")));
    await collect(stream(request("why?")));
    expect(model).toHaveBeenCalledTimes(3);

    now = 11 * 60_000; // kept for ten minutes
    await collect(stream(request("explain")));
    expect(model).toHaveBeenCalledTimes(4);
  });

  it("keeps nothing from a stream that failed", async () => {
    forgetAnswers();
    const failing = vi.fn(async function* () {
      yield "{";
      throw new Error("dropped");
    }) as unknown as StreamStructuredText;
    const stream = reusingAnswers(failing);
    await expect(collect(stream(request("explain")))).rejects.toThrow("dropped");
    await expect(collect(stream(request("explain")))).rejects.toThrow("dropped");
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
