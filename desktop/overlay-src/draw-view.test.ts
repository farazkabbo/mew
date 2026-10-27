import { describe, expect, it } from "vitest";

import {
  erase,
  parseBox,
  parseDrawView,
  parseLive,
  parseTool,
  rectPath,
  shapeStroke,
} from "./draw-view";

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

describe("the mouse stroke and box Rust reads", () => {
  it("accepts a stroke's new points and a box", () => {
    expect(parseLive({ start: true, points: [[1, 2]] })).toEqual({ start: true, points: [[1, 2]] });
    expect(parseBox({ from: [1, 2], to: [30, 40] })).toEqual({ from: [1, 2], to: [30, 40] });
  });

  it("refuses anything else", () => {
    expect(parseLive({ points: [[1, 2]] })).toBeNull();
    expect(parseLive({ start: false, points: [[1, Number.NaN]] })).toBeNull();
    expect(parseLive({ start: false, points: [[1, 2, 3]] })).toBeNull();
    expect(parseBox({ from: [1, 2] })).toBeNull();
    expect(parseBox(null)).toBeNull();
  });
});

describe("dotted marks", () => {
  it("keeps whether a mark is a select shape", () => {
    const view = parseDrawView({
      mode: "draw",
      marks: [
        { number: 1, points: [[1, 2]], dashed: true },
        { number: 2, points: [[3, 4]] },
      ],
    });
    expect(view?.marks?.map((m) => m.dashed === true)).toEqual([true, false]);
  });
});

describe("the island's tools", () => {
  it("reads the tool and shape, and refuses others", () => {
    expect(parseTool({ tool: "pen", shape: "rect" })).toEqual({ tool: "pen", shape: "rect" });
    expect(parseTool({ tool: "laser", shape: "rect" })).toBeNull();
    expect(parseTool({ tool: "pen" })).toBeNull();
  });

  it("makes a rectangle or ellipse from a drag's first and last points", () => {
    const drag: [number, number, number][] = [
      [100, 50, 0.5],
      [10, 10, 0.5],
      [20, 80, 0.5],
    ];
    const rect = shapeStroke("rect", drag);
    expect(rect?.[0]).toEqual([20, 50, 0.5]);
    expect(rect?.at(-1)).toEqual([20, 50, 0.5]);
    const ellipse = shapeStroke("ellipse", drag) ?? [];
    expect(Math.max(...ellipse.map((p) => p[0]))).toBeCloseTo(100);
    expect(Math.min(...ellipse.map((p) => p[1]))).toBeCloseTo(50);
    expect(shapeStroke("free", drag)).toEqual(drag);
    expect(
      shapeStroke("rect", [
        [0, 0, 0.5],
        [2, 30, 0.5],
      ]),
    ).toBeNull();
  });

  it("rubs out only the strokes the eraser touches", () => {
    const notes = [
      [
        [0, 0],
        [10, 0],
      ],
      [
        [100, 100],
        [110, 100],
      ],
    ] as [number, number][][];
    expect(erase(notes, [12, 3], 5)).toEqual([notes[1]]);
    expect(erase(notes, [50, 50], 5)).toEqual(notes);
  });
});
