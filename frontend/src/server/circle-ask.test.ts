import { type CircleAskRequest, type CircleStreamEvent, SAFE_FALLBACK } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

import { CIRCLE_FALLBACK, type CircleAskDeps, readQuestion, runCircleAsk } from "./circle-ask";
import { type GenerateStructured, ModelBusyError, type StreamStructuredText } from "./gemini";
import { completedArrayItems } from "./partial-json";

vi.stubEnv("GEMINI_API_KEY", "test-key");

const REQUEST: CircleAskRequest = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  question: { source: "none" },
  marks: [
    {
      number: 1,
      kind: "circle",
      box: { left: 200, top: 200, right: 600, bottom: 700 },
      polygon: [],
      text: "velocity (m/s)",
    },
  ],
  focus: { image: { jpeg: "/9j/", width: 800, height: 400 }, widthPx: 1000, heightPx: 500 },
  context: { jpeg: "/9j/", width: 1600, height: 900 },
  blocks: [],
  app: "msedge.exe",
  kind: "video",
  history: [],
};

const STEP_1 = {
  actions: [{ type: "underline", box: { left: 220, top: 600, right: 580, bottom: 620 } }],
  say: "This axis is velocity, not position.",
};
const STEP_2 = {
  actions: [{ type: "circle_region", box: { left: 300, top: 300, right: 500, bottom: 400 } }],
  say: "So a flat part means the speed isn't changing.",
};
const ANSWER = {
  readQuestion: "Explain this",
  steps: [STEP_1, STEP_2],
  summary: "A flat line on a velocity–time graph means constant speed.",
  followUpQuestion: "What's the acceleration on the flat part?",
  conceptHints: ["Acceleration"],
};

/** A model whose streamed text arrives in `chunks`; `generate` answers the retry. */
/** The model's answer to the non-streamed retry (an Error is thrown instead). */
function answering(generated: unknown) {
  return vi.fn(() => {
    if (generated instanceof Error) return Promise.reject(generated);
    if (generated === undefined) return Promise.reject(new Error("no answer"));
    return Promise.resolve(generated);
  });
}

function deps(chunks: string[], generated?: unknown) {
  const stream: StreamStructuredText = async function* () {
    for (const chunk of chunks) {
      await Promise.resolve();
      yield chunk;
    }
  };
  const generate = answering(generated);
  let clock = 0;
  const all: CircleAskDeps = {
    stream,
    generate: generate as unknown as GenerateStructured,
    now: () => (clock += 100),
    newTurnId: () => "22222222-2222-4222-8222-222222222222",
  };
  return { ...all, generate, all };
}

async function run(chunks: string[], generated?: unknown) {
  const d = deps(chunks, generated);
  const events: CircleStreamEvent[] = [];
  for await (const event of runCircleAsk(REQUEST, undefined, d.all)) events.push(event);
  return { events, generate: d.generate };
}

/** The answer's JSON cut into pieces, as a stream delivers it. */
function pieces(text: string, size = 40): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

describe("runCircleAsk", () => {
  it("sends each step as soon as it's written, then the rest", async () => {
    const { events, generate } = await run(pieces(JSON.stringify(ANSWER)));
    expect(events.map((e) => e.type)).toEqual(["step", "step", "done"]);
    expect(events[0]).toMatchObject({
      step: { index: 0, say: STEP_1.say, actions: STEP_1.actions },
    });
    expect(events[2]).toMatchObject({
      readQuestion: "Explain this",
      followUpQuestion: ANSWER.followUpQuestion,
      conceptHints: ["Acceleration"],
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("streams step 1 before the answer is finished", async () => {
    const text = JSON.stringify(ANSWER);
    const cut = text.indexOf(STEP_2.say);
    const d = deps([text.slice(0, cut), text.slice(cut)]);
    const iterator = runCircleAsk(REQUEST, undefined, d.all);
    const first = await iterator.next();
    expect(first.value).toMatchObject({ type: "step", step: { index: 0 } });
  });

  it("drops ink far from the marks", async () => {
    const wide = {
      ...ANSWER,
      steps: [
        {
          ...STEP_1,
          actions: [
            ...STEP_1.actions,
            { type: "circle_region", box: { left: 0, top: 0, right: 1000, bottom: 1000 } },
          ],
        },
        STEP_2,
      ],
    };
    const { events } = await run([JSON.stringify(wide)]);
    expect(events[0]).toMatchObject({ step: { actions: STEP_1.actions } });
  });

  it("aborts the whole answer when a step fails the safety check", async () => {
    const unsafe = {
      ...ANSWER,
      steps: [STEP_1, { ...STEP_2, say: "Now open PowerShell and paste this command." }],
    };
    const { events } = await run(pieces(JSON.stringify(unsafe)));
    expect(events.map((e) => e.type)).toEqual(["step", "abort"]);
    expect(events[1]).toEqual({ type: "abort", speech: SAFE_FALLBACK.speech });
  });

  it("keeps unsafe words out of the notebook", async () => {
    const { events } = await run([
      JSON.stringify({ ...ANSWER, followUpQuestion: "Can you type your password here?" }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      summary: "Explained on screen.",
      followUpQuestion: null,
      conceptHints: [],
    });
  });

  it("retries once without streaming when nothing usable came", async () => {
    const { events, generate } = await run(["{not json"], ANSWER);
    expect(generate).toHaveBeenCalledOnce();
    expect(events.map((e) => e.type)).toEqual(["step", "step", "done"]);
  });

  it("falls back to one caption without ink when it can't answer", async () => {
    const { events } = await run(["{not json"]);
    expect(events).toEqual([
      {
        type: "step",
        step: { index: 0, say: CIRCLE_FALLBACK, actions: [] },
        latencyMs: expect.any(Number) as number,
      },
      expect.objectContaining({ type: "done", summary: CIRCLE_FALLBACK }),
    ]);
  });

  it("says the model is busy instead of guessing", async () => {
    const d = deps([]).all;
    d.stream = async function* () {
      await Promise.resolve();
      yield* [];
      throw new ModelBusyError("m", 5000);
    };
    const events: CircleStreamEvent[] = [];
    for await (const event of runCircleAsk(REQUEST, undefined, d)) events.push(event);
    expect(events).toEqual([{ type: "error", message: expect.any(String) as string }]);
  });

  it("plays at most 5 steps", async () => {
    const many = { ...ANSWER, steps: Array.from({ length: 7 }, () => STEP_1) };
    const { events } = await run([JSON.stringify(many)]);
    expect(events.filter((e) => e.type === "step")).toHaveLength(5);
  });
});

describe("completedArrayItems", () => {
  it("returns the items finished so far, strings with brackets and all", () => {
    const text = '{"steps":[{"say":"a ] } [ \\" b"},{"say":"c"},{"say":"d';
    expect(completedArrayItems(text, "steps")).toEqual([{ say: 'a ] } [ " b' }, { say: "c" }]);
    expect(completedArrayItems('{"other":1}', "steps")).toEqual([]);
    expect(completedArrayItems('{"steps":[{"a":[1,2]}],"x":{"y":1}}', "steps")).toEqual([
      { a: [1, 2] },
    ]);
  });
});

describe("readQuestion", () => {
  it("asks the screen model to read the crop", async () => {
    const generate = answering({
      questions: ["Find x if 2x + 3 = 11"],
      handwritten: true,
      confidence: 0.82,
    });
    const read = await readQuestion(
      { image: { jpeg: "/9j/", width: 400, height: 120 } },
      undefined,
      generate as unknown as GenerateStructured,
    );
    expect(read.questions).toEqual(["Find x if 2x + 3 = 11"]);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [expect.anything(), { type: "image", base64: "/9j/", mimeType: "image/jpeg" }],
      }),
    );
  });
});
