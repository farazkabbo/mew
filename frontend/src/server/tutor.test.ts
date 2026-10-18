import type { TutorRequest, TutorResponse, TutorStreamEvent } from "@mew/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GenerateStructured, StreamStructuredText } from "./gemini";
import { completedStringField } from "./partial-json";
import { assertPng } from "./png";
import { runTutor } from "./tutor";

const request: TutorRequest = {
  intent: "answer_question",
  lastUtterance: "why does the force cancel out?",
  recentTranscript: [],
  pageImage: null,
  recognizedLines: [],
  answerStyle: "hints_first",
  depth: "normal",
  previousTutorSpeech: [],
  checks: [],
  courseContext: [],
};

const RESPONSE: TutorResponse = {
  speech: "What forces act on the block? Compare their directions.",
  actions: [{ type: "write_text", text: "ΣF = 0", anchor: { near: "below_active_line" } }],
};

/** Streams `text` in chunks of `size` characters. */
function streaming(text: string, size = 7): StreamStructuredText {
  return async function* () {
    for (let i = 0; i < text.length; i += size) {
      await Promise.resolve();
      yield text.slice(i, i + size);
    }
  };
}

function failingStream(afterText: string): StreamStructuredText {
  return async function* () {
    yield afterText;
    await Promise.resolve();
    throw new Error("stream dropped");
  };
}

const neverCalled = vi.fn(() =>
  Promise.reject(new Error("unexpected retry")),
) as unknown as GenerateStructured;

async function collect(events: AsyncIterable<TutorStreamEvent>) {
  const out: TutorStreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

let clock = 0;
const now = () => (clock += 100);

beforeEach(() => {
  clock = 0;
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("completedStringField", () => {
  it("returns null until the closing quote arrives, then the decoded string", () => {
    const full = JSON.stringify(RESPONSE);
    const cut = full.indexOf("Compare");

    expect(completedStringField(full.slice(0, cut), "speech")).toBeNull();
    expect(completedStringField(full, "speech")).toBe(RESPONSE.speech);
  });

  it("handles escaped quotes and backslashes", () => {
    const text = JSON.stringify({ speech: 'He said "no" \\ then left', actions: [] });

    expect(completedStringField(text, "speech")).toBe('He said "no" \\ then left');
    expect(completedStringField(text.slice(0, 18), "speech")).toBeNull();
  });
});

describe("runTutor", () => {
  it("emits speech before the response completes, then the validated response", async () => {
    const text = JSON.stringify(RESPONSE);
    const events = await collect(
      runTutor(request, undefined, { stream: streaming(text), generate: neverCalled, now }),
    );

    expect(events.map((e) => e.type)).toEqual(["speech", "response"]);
    expect(events[0]).toMatchObject({ type: "speech", text: RESPONSE.speech });
    expect(events[1]).toMatchObject({ type: "response", response: RESPONSE });
  });

  it.each([1, 3, 64])("works for any chunking (chunk size %i)", async (size) => {
    const events = await collect(
      runTutor(request, undefined, {
        stream: streaming(JSON.stringify(RESPONSE), size),
        generate: neverCalled,
        now,
      }),
    );

    expect(events[0]).toMatchObject({ type: "speech", text: RESPONSE.speech });
  });

  it("retries once when the streamed JSON is invalid, keeping what was already spoken", async () => {
    const broken = `{"speech":"Look at the arrows.","actions":[{"type":"nope"}]}`;
    const generate = vi.fn(() => Promise.resolve(RESPONSE)) as unknown as GenerateStructured;
    const events = await collect(
      runTutor(request, undefined, { stream: streaming(broken), generate, now }),
    );

    expect(events).toMatchObject([
      { type: "speech", text: "Look at the arrows." },
      { type: "response", response: { speech: "Look at the arrows.", actions: RESPONSE.actions } },
    ]);
  });

  it("degrades to speech only when generation fails after speech was sent", async () => {
    const partial = `{"speech":"Check your signs.","actions":[{"ty`;
    const events = await collect(
      runTutor(request, undefined, { stream: failingStream(partial), generate: neverCalled, now }),
    );

    expect(events).toMatchObject([
      { type: "speech", text: "Check your signs." },
      { type: "response", response: { speech: "Check your signs.", actions: [] } },
    ]);
  });

  it("reports an error when nothing could be said", async () => {
    const events = await collect(
      runTutor(request, undefined, { stream: failingStream("{"), generate: neverCalled, now }),
    );

    expect(events).toEqual([{ type: "error", message: "The tutor is unavailable right now." }]);
  });

  it("stays silent when the client hung up", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      runTutor(request, controller.signal, {
        stream: failingStream("{"),
        generate: neverCalled,
        now,
      }),
    );

    expect(events).toEqual([]);
  });
});

describe("assertPng", () => {
  function png(width: number, height: number): string {
    const bytes = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes.toString("base64");
  }

  it("accepts a PNG within limits and reports its size", () => {
    expect(assertPng(png(800, 120))).toEqual({ width: 800, height: 120 });
  });

  it.each([
    ["not base64", "%%%"],
    ["a JPEG", Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(30).fill(0)]).toString("base64")],
    ["an oversized image", png(5000, 10)],
    ["a zero-size image", png(0, 10)],
  ])("rejects %s", (_label, data) => {
    expect(() => assertPng(data)).toThrow(expect.objectContaining({ status: 400 }));
  });
});
