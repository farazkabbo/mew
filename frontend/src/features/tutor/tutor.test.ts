import { PageDocument, segmentLines, strokeBBox } from "@mew/ink";
import type { LineCheck, Point, Stroke, TutorStreamEvent } from "@mew/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ExportLine from "../notebook/export-line";

// Rendering needs OffscreenCanvas (browser only); context building is covered by e2e tests.
vi.mock("./context", () => ({
  buildTutorRequest: vi.fn((input: { intent: string; utterance: string }) =>
    Promise.resolve({ intent: input.intent, lastUtterance: input.utterance }),
  ),
}));
vi.mock("../notebook/export-line", async (original) => ({
  ...(await original<typeof ExportLine>()),
  renderStrokesPng: () =>
    Promise.resolve({ blob: new Blob([new Uint8Array([1, 2, 3])]), width: 1, height: 1 }),
}));

import { TutorController } from "./controller";
import { isLikelyEcho, newWords } from "./echo";
import { Pcm16Decoder } from "./pcm";
import type { PcmStreamPlayer } from "./pcm-player";
import { RecognitionService } from "./recognition";
import { useTutor } from "./store";

const SPEECH = "Look at the directions of the two forces.";

function ndjson(events: TutorStreamEvent[]): Response {
  return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

const happyTutor = () =>
  ndjson([
    { type: "speech", text: SPEECH, latencyMs: 400 },
    {
      type: "response",
      response: {
        speech: SPEECH,
        actions: [{ type: "write_text", text: "F₁ = −F₂", anchor: { near: "below_active_line" } }],
      },
      latencyMs: 900,
    },
  ]);

/** A player whose playback lasts until `finish()` or `stop()`. */
function fakePlayer() {
  let end: (() => void) | null = null;
  const player = {
    unlock: vi.fn(),
    play: vi.fn((_stream: ReadableStream, opts: { onStart?: () => void }) => {
      opts.onStart?.();
      return new Promise<void>((resolve) => (end = resolve));
    }),
    stop: vi.fn(() => end?.()),
  };
  return { player: player as unknown as PcmStreamPlayer & typeof player, finish: () => end?.() };
}

function routeFetch(tutor: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(url === "/api/tutor" ? tutor() : new Response(new Uint8Array([0, 0, 1, 0]))),
    ),
  );
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function controller(player: PcmStreamPlayer) {
  const onFinished = vi.fn();
  const ink = {
    render: vi.fn((_actions: unknown, opts?: { onStart?: () => void }) => {
      opts?.onStart?.();
      return Promise.resolve({ strokes: 7, skipped: [], missing: [], groupId: "g", bbox: null });
    }),
    pause: vi.fn(),
    finish: vi.fn(),
  };
  const tutor = new TutorController({
    player,
    recognition: new RecognitionService(),
    ink,
    doc: () => null,
    onFinished,
  });
  return { tutor, onFinished, ink };
}

const turnInput = {
  intent: "answer_question" as const,
  utterance: "why?",
  triggeredAt: Date.now(),
  gateMs: 200,
};

beforeEach(() => {
  useTutor.setState({ phase: "idle", caption: null, turns: [], lastFinishedAt: null });
});
afterEach(() => vi.unstubAllGlobals());

describe("TutorController", () => {
  it("speaks the reply, records actions and timings, then finishes", async () => {
    routeFetch(happyTutor);
    const { player, finish } = fakePlayer();
    const { tutor, onFinished } = controller(player);

    const done = tutor.respond(turnInput);
    await flush();
    expect(useTutor.getState().phase).toBe("speaking");
    expect(useTutor.getState().caption).toBe(SPEECH);

    finish();
    await done;
    const [turn] = useTutor.getState().turns;
    expect(turn).toMatchObject({ outcome: "done", speech: SPEECH });
    expect(turn?.actions).toHaveLength(1);
    expect(turn?.timings).toMatchObject({ gateMs: 200 });
    expect(turn?.timings.firstAudioMs).toBeTypeOf("number");
    expect(useTutor.getState().phase).toBe("idle");
    expect(onFinished).toHaveBeenCalledOnce();
  });

  it("writes the board actions as ink, paced to the speech, and times the ink start", async () => {
    routeFetch(happyTutor);
    const { player, finish } = fakePlayer();
    const { tutor, ink } = controller(player);

    const done = tutor.respond(turnInput);
    await flush();
    finish();
    await done;

    expect(ink.finish).toHaveBeenCalled(); // the previous turn's ink was settled first
    expect(ink.render).toHaveBeenCalledWith(
      [{ type: "write_text", text: "F₁ = −F₂", anchor: { near: "below_active_line" } }],
      expect.objectContaining({ speech: SPEECH }),
    );
    const [turn] = useTutor.getState().turns;
    expect(turn?.ink).toEqual({ strokes: 7, skipped: [], missing: [] });
    expect(turn?.timings.inkStartMs).toBeTypeOf("number");
  });

  it("pauses the ink when the student writes or speaks, even after the speech has ended", async () => {
    routeFetch(happyTutor);
    const { player, finish } = fakePlayer();
    const { tutor, ink } = controller(player);
    const done = tutor.respond(turnInput);
    await flush();
    finish();
    await done;

    tutor.writing();
    expect(ink.pause).toHaveBeenCalledTimes(1);
    tutor.heard("the directions of the two"); // its own voice: ignored
    expect(ink.pause).toHaveBeenCalledTimes(1);
    tutor.heard("wait so what happens to the normal force");
    expect(ink.pause).toHaveBeenCalledTimes(2);
  });

  it("barges in when the student speaks over it, fading out quickly", async () => {
    routeFetch(happyTutor);
    const { player } = fakePlayer();
    const { tutor } = controller(player);

    const done = tutor.respond(turnInput);
    await flush();
    tutor.heard("wait no I meant the other one");
    await done;

    expect(player.stop).toHaveBeenCalledWith(150);
    expect(useTutor.getState().turns[0]?.outcome).toBe("interrupted");
  });

  it("does not mistake its own voice in the microphone for a barge-in", async () => {
    routeFetch(happyTutor);
    const { player, finish } = fakePlayer();
    const { tutor } = controller(player);

    const done = tutor.respond(turnInput);
    await flush();
    tutor.heard("look at the directions of the two");
    expect(player.stop).not.toHaveBeenCalled();

    finish();
    await done;
    expect(tutor.isEcho("the directions of the two forces")).toBe(true);
    expect(tutor.isEcho("why is the normal force upward")).toBe(false);
  });

  it("stops when the student starts writing", async () => {
    routeFetch(happyTutor);
    const { player } = fakePlayer();
    const { tutor } = controller(player);

    const done = tutor.respond(turnInput);
    await flush();
    tutor.writing();
    await done;

    expect(useTutor.getState().turns[0]?.outcome).toBe("interrupted");
  });

  it("lets a new turn supersede a running one without the old one resetting state", async () => {
    routeFetch(happyTutor);
    const { player, finish } = fakePlayer();
    const { tutor, onFinished } = controller(player);

    const first = tutor.respond(turnInput);
    await flush();
    const second = tutor.respond({ ...turnInput, utterance: "and the friction?" });
    await first;
    expect(useTutor.getState().phase).not.toBe("idle"); // the second turn is still running
    expect(onFinished).not.toHaveBeenCalled();

    await flush();
    finish();
    await second;
    expect(useTutor.getState().turns.map((t) => t.outcome)).toEqual(["done", "interrupted"]);
    expect(onFinished).toHaveBeenCalledOnce();
  });

  it("shows a short apology when the tutor fails", async () => {
    routeFetch(() =>
      ndjson([{ type: "error", message: "I couldn't answer just now — try again in a moment." }]),
    );
    const { player } = fakePlayer();
    const { tutor } = controller(player);

    await tutor.respond(turnInput);

    expect(useTutor.getState().turns[0]?.outcome).toBe("failed");
    expect(useTutor.getState().caption).toMatch(/couldn't answer/);
    expect(player.play).not.toHaveBeenCalled();
  });

  const wrongLine: LineCheck = {
    lineId: "line_b",
    checker: "math",
    verdict: "incorrect",
    reason: "changes_solutions",
    detail: "x = 2 before, x = 5 after",
    target: true,
  };

  it("sends verified checks to the model and keeps its marks consistent with them", async () => {
    let sent: { checks?: LineCheck[] } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (url !== "/api/tutor") return Promise.resolve(new Response(new Uint8Array([0, 0])));
        sent = JSON.parse(String(init?.body)) as typeof sent;
        return Promise.resolve(
          ndjson([
            { type: "speech", text: "Check what you did with the three.", latencyMs: 300 },
            {
              type: "response",
              // The model wrongly ticks the line the verifier found wrong.
              response: {
                speech: "Check what you did with the three.",
                actions: [{ type: "mark_correct", targetLineId: "line_b" }],
              },
              latencyMs: 600,
            },
          ]),
        );
      }),
    );
    const { player, finish } = fakePlayer();
    const { tutor, ink } = controller(player);
    const done = tutor.respond({ ...turnInput, intent: "check_work", checks: [wrongLine] });
    await flush();
    finish();
    await done;

    expect(sent.checks).toEqual([wrongLine]);
    expect(ink.render).toHaveBeenCalledWith(
      [{ type: "mark_error", targetLineId: "line_b", note: "check this step" }],
      expect.anything(),
    );
    expect(useTutor.getState().turns[0]?.checks).toEqual([wrongLine]);
  });

  it("still circles a verified mistake when the model is unavailable", async () => {
    routeFetch(() =>
      ndjson([{ type: "error", message: "I couldn't answer just now — try again in a moment." }]),
    );
    const { player } = fakePlayer();
    const { tutor, ink } = controller(player);

    await tutor.respond({ ...turnInput, intent: "check_work", checks: [wrongLine] });

    expect(ink.render).toHaveBeenCalledWith(
      [{ type: "mark_error", targetLineId: "line_b", note: "check this step" }],
      expect.anything(),
    );
    expect(useTutor.getState().caption).toMatch(/have another look/);
  });
});

describe("echo detection", () => {
  it("counts words the tutor didn't say", () => {
    expect(newWords("look at the forces", SPEECH)).toBe(0);
    expect(newWords("hold on, what about friction", SPEECH)).toBe(5);
  });

  it("treats mostly-overlapping transcripts as echo", () => {
    expect(isLikelyEcho("the directions of the two forces", SPEECH)).toBe(true);
    expect(isLikelyEcho("why is it negative", SPEECH)).toBe(false);
    expect(isLikelyEcho("", SPEECH)).toBe(false);
  });
});

describe("Pcm16Decoder", () => {
  it("decodes little-endian samples split across chunks", () => {
    const decoder = new Pcm16Decoder();
    // 0x0001 = 1, 0xFFFF = -1, 0x8000 = -32768; second sample split across chunks.
    const a = decoder.decode(Uint8Array.of(0x01, 0x00, 0xff));
    const b = decoder.decode(Uint8Array.of(0xff, 0x00, 0x80));

    expect(Array.from(a).map((v) => Math.round(v * 0x8000))).toEqual([1]);
    expect(Array.from(b).map((v) => Math.round(v * 0x8000))).toEqual([-1, -32768]);
  });
});

describe("RecognitionService", () => {
  function line(): { doc: PageDocument; stroke: Stroke } {
    const points: Point[] = [
      [0, 0, 0.5, 0],
      [50, 10, 0.5, 20],
    ];
    const stroke: Stroke = {
      id: crypto.randomUUID(),
      pageId: crypto.randomUUID(),
      author: "student",
      tool: "pen",
      points,
      color: "#1d1c1a",
      width: 2,
      bbox: strokeBBox(points, 2),
      createdAt: 1,
    };
    return { doc: new PageDocument([stroke]), stroke };
  }

  it("caches by the line's strokes and shares concurrent requests", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json({ text: "x = 4", latex: "x = 4", subject: "math", confidence: 0.9 }),
      ),
    );
    const service = new RecognitionService(fetchMock as unknown as typeof fetch);
    const { doc } = line();
    const [l] = segmentLines(doc.all());
    if (!l) throw new Error("no line");

    const [a, b] = await Promise.all([service.recognize(doc, l), service.recognize(doc, l)]);
    await service.recognize(doc, l);

    expect(a?.text).toBe("x = 4");
    expect(b).toEqual(a);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(service.currentLineText(doc)).toBe("x = 4");
  });

  it("stops asking once the server says recognition isn't configured", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 503 })));
    const service = new RecognitionService(fetchMock as unknown as typeof fetch);
    const { doc } = line();
    const [l] = segmentLines(doc.all());
    if (!l) throw new Error("no line");

    await service.recognize(doc, l);
    await service.recognize(doc, l);

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
