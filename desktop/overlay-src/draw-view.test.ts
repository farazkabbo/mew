import { describe, expect, it } from "vitest";

import { parseDrawView, rectPath } from "./draw-view";

describe("the draw overlay's view", () => {
  it("accepts what Rust sends", () => {
    const view = {
      marks: [
        {
          number: 1,
          points: [
            [10, 20],
            [30, 40],
          ],
        },
      ],
      grey: false,
      drawing: true,
      mode: "draw",
    };
    expect(parseDrawView(view)).toEqual(view);
    expect(parseDrawView({ mode: "select" })).toEqual({ mode: "select" });
    expect(parseDrawView({ mode: "keyboard", blocks: [[1, 2, 30, 10]], pointer: [5, 6] })).toEqual({
      mode: "keyboard",
      blocks: [[1, 2, 30, 10]],
      pointer: [5, 6],
    });
  });

  it("turns a box into a closed path (a circle to Rust)", () => {
    const path = rectPath([10, 20, 80, 40]);
    expect(path[0]).toEqual([10, 20, 0.5]);
    expect(path.at(-1)).toEqual([10, 20, 0.5]);
    expect(path).toHaveLength(33);
    expect(path.some(([x, y]) => x === 90 && y === 60)).toBe(true);
  });

  it("refuses anything else", () => {
    for (const bad of [
      null,
      { mode: "paint" },
      { mode: "draw", marks: [{ number: 4, points: [] }] },
      { mode: "draw", marks: [{ number: 1, points: [[1, Number.NaN]] }] },
      { mode: "draw", marks: [{ number: 1, points: [[1, 2, 3]] }] },
      {
        mode: "draw",
        marks: Array.from({ length: 4 }, (_, i) => ({ number: (i % 3) + 1, points: [] })),
      },
      { mode: "draw", grey: "yes" },
      { mode: "keyboard", blocks: [[1, 2, 3]] },
      { mode: "keyboard", pointer: [1, Number.POSITIVE_INFINITY] },
    ]) {
      expect(parseDrawView(bad)).toBeNull();
    }
  });
});
