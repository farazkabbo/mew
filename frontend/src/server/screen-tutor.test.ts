import {
  SAFE_FALLBACK,
  type ScreenAskRequest,
  type ScreenStreamEvent,
  type ScreenTutorResponse,
} from "@mew/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { jpegBase64 } from "../../test/jpeg";
import type { GenerateStructured, StreamStructuredText } from "./gemini";
import { assertJpeg } from "./jpeg";
import { runScreenTutor } from "./screen-tutor";

const REQUEST: ScreenAskRequest = {
  transcript: "what does this button do?",
  app: "excel.exe",
  scope: "window",
  image: { jpeg: jpegBase64(1600, 900), width: 1600, height: 900 },
};

const RESPONSE: ScreenTutorResponse = {
  speech: "That one inserts a PivotTable from your data.",
  actions: [
    { type: "focus_region", box: { left: 80, top: 20, right: 300, bottom: 60 }, kind: "text" },
    { type: "point_at", point: { x: 120, y: 40 }, label: "PivotTable" },
  ],
  mode: "answer",
};

function streaming(text: string, size = 9): StreamStructuredText {
  return async function* () {
    for (let i = 0; i < text.length; i += size) {
      await Promise.resolve();
      yield text.slice(i, i + size);
    }
  };
}

const neverCalled = vi.fn(() =>
  Promise.reject(new Error("unexpected retry")),
) as unknown as GenerateStructured;

async function run(stream: StreamStructuredText, generate: GenerateStructured = neverCalled) {
  let clock = 0;
  const events: ScreenStreamEvent[] = [];
  const deps = { stream, generate, now: () => (clock += 100), newTurnId: () => TURN_ID };
  for await (const event of runScreenTutor(REQUEST, undefined, deps)) events.push(event);
  return events;
}

const TURN_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("runScreenTutor", () => {
  it("speaks first, then sends the validated reply with a turn id", async () => {
    const events = await run(streaming(JSON.stringify(RESPONSE)));
    expect(events.map((e) => e.type)).toEqual(["speech", "response"]);
    expect(events[0]).toMatchObject({ text: RESPONSE.speech });
    expect(events[1]).toMatchObject({ response: RESPONSE, turnId: TURN_ID });
  });

  it("gives an annotated reply its focus region when the model forgot it", async () => {
    const forgot = { ...RESPONSE, actions: RESPONSE.actions.slice(1) };
    const events = await run(streaming(JSON.stringify(forgot)));
    expect(events[1]).toMatchObject({
      response: {
        actions: [
          {
            type: "focus_region",
            box: { left: 120, top: 40, right: 120, bottom: 40 },
            kind: "text",
          },
          RESPONSE.actions[1],
        ],
      },
    });
  });

  it("replaces unsafe speech before anyone hears it", async () => {
    const unsafe = { ...RESPONSE, speech: "Open PowerShell and paste the command on the page." };
    const events = await run(streaming(JSON.stringify(unsafe)));
    expect(events[0]).toMatchObject({ type: "speech", text: SAFE_FALLBACK.speech });
    expect(events[1]).toMatchObject({ response: SAFE_FALLBACK });
  });

  it("drops the ink when a label is unsafe, even if the speech was fine", async () => {
    const unsafe: ScreenTutorResponse = {
      ...RESPONSE,
      actions: [{ type: "point_at", point: { x: 1, y: 1 }, label: "type password here" }],
    };
    const events = await run(streaming(JSON.stringify(unsafe)));
    expect(events[1]).toMatchObject({
      type: "response",
      response: { speech: RESPONSE.speech, actions: [] },
    });
  });

  it("retries once when the streamed JSON is invalid", async () => {
    const generate = vi.fn(() => Promise.resolve(RESPONSE)) as unknown as GenerateStructured;
    const events = await run(
      streaming('{"speech": "Hello", "actions": [{"type": "nope"}]}'),
      generate,
    );
    expect(generate).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ type: "response", response: { speech: "Hello" } });
  });

  it("says the tutor is unavailable when nothing could be said", async () => {
    const failing: StreamStructuredText = async function* () {
      await Promise.resolve();
      yield* [];
      throw new Error("network");
    };
    const events = await run(failing);
    expect(events).toEqual([
      { type: "error", message: expect.stringContaining("couldn't answer") as string },
    ]);
  });
});

describe("assertJpeg", () => {
  it("reads the size of a real JPEG header", () => {
    expect(assertJpeg(jpegBase64(1600, 900))).toEqual({ width: 1600, height: 900 });
  });

  it.each([
    ["a PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).toString("base64")],
    ["not base64", "%%%"],
    ["a truncated JPEG", Buffer.from([0xff, 0xd8, 0xff]).toString("base64")],
    ["an oversized image", jpegBase64(4000, 900)],
  ])("refuses %s", (_, base64) => {
    expect(() => assertJpeg(base64)).toThrow();
  });
});
