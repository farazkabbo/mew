import type { BoardAction, Point, Stroke } from "@mew/shared";
import { bboxesIntersect, PageDocument, strokeBBox } from "@mew/ink";
import { describe, expect, it, vi } from "vitest";

import type { PageEngine } from "../notebook/engine";
import { type InkClock, TutorInk } from "./ink";

const PAGE = "00000000-0000-4000-8000-0000000000aa";
let n = 0;
const newId = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;
const COLORS = { ink: "#8a7bf0", error: "#c8432b", correct: "#2f7d55" };

/** A manual clock: frames and timeouts run only when the test advances time. */
function fakeClock() {
  let now = 0;
  let frames: (() => void)[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  const clock: InkClock = {
    now: () => now,
    frame: (fn) => {
      frames.push(fn);
      return () => (frames = frames.filter((f) => f !== fn));
    },
    timeout: (fn, ms) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
  };
  return {
    clock,
    /** Advances time in 16 ms frames. */
    advance(ms: number) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + 16);
        for (const t of timers.filter((t) => t.at <= now)) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
        const run = frames;
        frames = [];
        run.forEach((f) => f());
      }
    },
  };
}

function studentStroke(x: number, y: number, createdAt: number): Stroke {
  const points: Point[] = [
    [x, y + 24, 0.5, 0],
    [x + 8, y, 0.5, 10],
    [x + 16, y + 24, 0.5, 20],
  ];
  return {
    id: newId(),
    pageId: PAGE,
    author: "student",
    tool: "pen",
    points,
    color: "#1d1c1a",
    width: 3,
    bbox: strokeBBox(points, 3),
    createdAt,
  };
}

function fakeEngine(strokes: Stroke[]) {
  const doc = new PageDocument(strokes);
  const committed: Stroke[][] = [];
  const engine = {
    pageId: PAGE,
    doc,
    images: [],
    addTutorStrokes: vi.fn((list: readonly Stroke[]) => {
      committed.push([...list]);
      doc.add(list);
    }),
  };
  return { engine: engine as unknown as PageEngine, committed, doc };
}

const line = () => Array.from({ length: 6 }, (_, i) => studentStroke(100 + i * 20, 100, i));
const math = (latex: string, near: "active_line" | "below_active_line" = "active_line") =>
  ({ type: "write_math", latex, anchor: { near } }) as BoardAction;

function setup(strokes = line()) {
  const time = fakeClock();
  const page = fakeEngine(strokes);
  const ink = new TutorInk({
    engine: () => page.engine,
    colors: () => COLORS,
    newId,
    clock: time.clock,
  });
  ink.attachViewport(() => [0, 0, 1200, 800]);
  return { ink, time, ...page };
}

describe("TutorInk", () => {
  it("writes progressively, then commits the whole turn as one step", async () => {
    const { ink, time, committed } = setup();
    const onStart = vi.fn();
    const result = await ink.render([math("F_1 = -F_2")], {
      speech: "Look at the forces.",
      onStart,
    });

    expect(result.strokes).toBeGreaterThan(4);
    expect(onStart).toHaveBeenCalledOnce();
    time.advance(200);
    const midway = ink.liveStrokes().length;
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(result.strokes);
    expect(committed).toHaveLength(0);

    time.advance(10_000);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toHaveLength(result.strokes);
    expect(committed[0]?.every((s) => s.author === "tutor")).toBe(true);
    expect(ink.liveStrokes()).toEqual([]);
    expect(ink.busy).toBe(false);
  });

  it("paces writing to the speech, within limits", async () => {
    const short = setup();
    await short.ink.render([math("x = 2")], { speech: "Yes." });
    short.time.advance(1300);
    expect(short.committed).toHaveLength(1); // a short reply finishes in ~1.2 s

    const long = setup();
    await long.ink.render([math("x = 2")], { speech: "word ".repeat(80) });
    long.time.advance(1300);
    expect(long.committed).toHaveLength(0); // slowed down to match a long reply
  });

  it("pauses on barge-in and resumes after the student goes quiet", async () => {
    const { ink, time, committed } = setup();
    await ink.render([math("a + b = c")], { speech: "Here is the idea in full." });
    time.advance(150);
    ink.pause();
    const frozen = ink.liveStrokes().length;
    time.advance(1000); // still within the quiet window
    expect(ink.liveStrokes().length).toBe(frozen);
    ink.pause(); // more activity restarts the wait
    time.advance(1000);
    expect(ink.liveStrokes().length).toBe(frozen);
    time.advance(20_000); // quiet: resumes and finishes
    expect(committed).toHaveLength(1);
  });

  it("commits unfinished ink immediately when finished early (new turn, page change)", async () => {
    const { ink, time, committed } = setup();
    const { strokes } = await ink.render([math("y = mx + c")], { speech: "Slope." });
    time.advance(50);
    ink.finish();
    expect(committed[0]).toHaveLength(strokes);
    await ink.render([math("x = 1")]);
    expect(committed).toHaveLength(1); // the new turn doesn't re-commit the old one
  });

  it("still lands a plan that a newer turn overtook while it was being made", async () => {
    const { ink, committed } = setup();
    const first = ink.render([math("a = b", "below_active_line")]);
    const second = ink.render([math("c = d", "below_active_line")]);
    await Promise.all([first, second]);
    expect(committed).toHaveLength(1); // the first turn's ink, committed without animating
    expect(ink.busy).toBe(true); // the second is being written
  });

  it("moves unwritten ink out of the way if the student wrote there during a pause", async () => {
    const { ink, time, committed, doc } = setup();
    await ink.render([math("a = b", "below_active_line"), math("c = d", "below_active_line")]);
    ink.pause();
    // The student fills the space below their line while the tutor waits.
    const scribbles = Array.from({ length: 30 }, (_, i) =>
      studentStroke(90 + (i % 10) * 20, 140 + Math.floor(i / 10) * 30, 100 + i),
    );
    doc.add(scribbles);
    time.advance(30_000);
    const tutor = committed[0] ?? [];
    expect(tutor.length).toBeGreaterThan(0);
    for (const t of tutor) {
      expect(scribbles.some((s) => bboxesIntersect(t.bbox, s.bbox))).toBe(false);
    }
  });

  it("reports actions it couldn't draw and draws nothing without a page", async () => {
    const { ink } = setup();
    const result = await ink.render([
      { type: "mark_correct", targetLineId: "line_missing" },
      math("x"),
    ]);
    expect(result.skipped).toEqual([{ index: 0, type: "mark_correct", reason: "unknown line" }]);
    expect(result.strokes).toBeGreaterThan(0);

    const pageless = new TutorInk({ engine: () => null, colors: () => COLORS });
    expect(await pageless.render([math("x")])).toEqual({ strokes: 0, skipped: [], missing: [] });
  });
});
