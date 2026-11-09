import { readFileSync } from "node:fs";
import path from "node:path";

import type { CircleAskRequest } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

import { runCircleAsk } from "./circle-ask";
import { IMAGE_TOKENS, type InputPart, type StreamStructuredText } from "./gemini";

vi.mock("server-only", () => ({}));

/**
 * The circle-and-ask budget (docs/PLAN.md, Part 4): the measured "after" input (2,390 tokens for
 * circling a maths line, `pnpm eval:tokens`) plus 10%. Estimated here without the model: images
 * at their resolution's price, text at the characters per token the measurement showed.
 */
const CIRCLE_ASK_BUDGET = 2630;
/** Characters per token for our prompts and JSON (calibrated against the measured turn). */
const CHARS_PER_TOKEN = 3.9;

const jpeg = (name: string) =>
  readFileSync(path.join(import.meta.dirname, "../../evals/tokens", `${name}.jpg`)).toString(
    "base64",
  );

const MATHS: CircleAskRequest = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  question: { source: "voice", text: "explain" },
  marks: [
    {
      number: 1,
      kind: "circle",
      box: { left: 60, top: 80, right: 940, bottom: 920 },
      polygon: [],
      text: "3x + 7 = 19",
    },
  ],
  focus: {
    image: { jpeg: jpeg("maths-focus"), width: 560, height: 120 },
    widthPx: 560,
    heightPx: 120,
  },
  context: { jpeg: jpeg("maths-context"), width: 1600, height: 900 },
  blocks: [{ id: "b1", text: "3x + 7 = 19", box: { left: 60, top: 80, right: 940, bottom: 920 } }],
  app: "msedge.exe",
  kind: "browser",
  history: [],
};

function estimate(system: string, input: string | readonly InputPart[]): number {
  const parts = typeof input === "string" ? [{ type: "text" as const, text: input }] : input;
  let chars = system.length;
  let images = 0;
  for (const part of parts) {
    if (part.type === "text") chars += part.text.length;
    else images += IMAGE_TOKENS[part.resolution ?? "high"];
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images;
}

describe("tokens per question", () => {
  it("keeps circling a maths line and asking 'explain' within its budget", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    let sent: Parameters<StreamStructuredText>[0] | undefined;
    const stream = vi.fn(async function* (request: Parameters<StreamStructuredText>[0]) {
      sent = request;
      yield "";
      throw new Error("stop: only the request is wanted");
    }) as unknown as StreamStructuredText;
    const deps = {
      stream,
      generate: vi.fn(async () => {
        throw new Error("stop");
      }),
      now: () => 0,
      newTurnId: () => "22222222-2222-4222-8222-222222222222",
    };
    // Only the request it built matters here; the events are played out and dropped.
    const events = runCircleAsk(MATHS, undefined, deps);
    while (!(await events.next()).done);

    expect(sent).toBeDefined();
    if (!sent) return;
    // The marked line at medium resolution, and no window around it: its words say enough.
    expect(sent.input).toHaveLength(2);
    expect(estimate(sent.system, sent.input)).toBeLessThanOrEqual(CIRCLE_ASK_BUDGET);
  });
});
