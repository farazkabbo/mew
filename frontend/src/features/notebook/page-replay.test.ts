import type { Stroke } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

import { pageReplayPlan, replayPage } from "./page-replay";

const stroke = (id: string, createdAt: number, extra: Partial<Stroke> = {}) =>
  ({ id, createdAt, ...extra }) as Stroke;

describe("page Replay (K9)", () => {
  it("draws strokes in the order they were made, pauses shortened", () => {
    const plan = pageReplayPlan([
      stroke("b", 1_000),
      stroke("a", 0),
      stroke("c", 3_600_000, { markKind: "tick", author: "tutor" }),
      stroke("d", 3_600_000),
    ]);
    expect(plan).toEqual([
      { at: 0, ids: ["a"] },
      { at: 700, ids: ["b"] },
      { at: 1400, ids: ["c", "d"] },
    ]);
  });

  it("keeps a long page under a minute", () => {
    const many = Array.from({ length: 500 }, (_, i) => stroke(String(i), i * 10_000));
    expect(pageReplayPlan(many).at(-1)?.at).toBeLessThanOrEqual(45_000);
  });

  it("hides everything, then shows strokes one frame at a time, and stops at once", () => {
    vi.useFakeTimers();
    const shown: number[] = [];
    const done = vi.fn();
    replayPage([stroke("a", 0), stroke("b", 1000)], (ids) => shown.push(ids.size), done);
    vi.runAllTimers();
    expect(shown).toEqual([2, 1, 0, 0]);
    expect(done).toHaveBeenCalledOnce();

    shown.length = 0;
    const stop = replayPage(
      [stroke("a", 0), stroke("b", 1000)],
      (ids) => shown.push(ids.size),
      done,
    );
    stop();
    vi.runAllTimers();
    vi.useRealTimers();
    expect(shown).toEqual([2, 0]);
  });
});
