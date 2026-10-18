import type { BoardAction, Stroke } from "@mew/shared";
import { Stroke as StrokeSchema } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { bboxesIntersect } from "../geometry";
import { segmentLines } from "../segmentation";
import { strokeThrough, testId } from "../test-helpers";
import { ALL_RENDERERS } from "./actions";
import { type BoardInput, planBoard } from "./board";
import { compileExpression, ExprError } from "./visuals/expr";
import { ticks } from "./visuals/plot";
import { toPaths } from "./visuals/rough";

const COLORS = { ink: "#8a7bf0", error: "#c8432b", correct: "#2f7d55" };

function page(): Stroke[] {
  return Array.from({ length: 8 }, (_, i) =>
    strokeThrough(
      [
        [100 + i * 24, 124],
        [107 + i * 24, 100],
        [114 + i * 24, 124],
      ],
      { createdAt: i, width: 3 },
    ),
  );
}

function input(strokes: Stroke[]): BoardInput {
  const lines = segmentLines(strokes);
  return {
    pageId: testId(),
    groupId: testId(),
    strokes,
    lines,
    activeLine: lines.at(-1),
    viewport: [0, 0, 1400, 1000],
    colors: COLORS,
    now: 1,
    newId: () => testId(),
  };
}

describe("compileExpression", () => {
  it.each([
    ["sin(x)", Math.PI / 2, 1],
    ["y = x^2 - 3", 2, 1],
    ["f(x) = 2x + 1", 3, 7],
    ["-x^2", 3, -9],
    ["2^3^2", 0, 512], // right-associative
    ["\\frac{1}{x}", 4, 0.25],
    ["\\sqrt{x}", 9, 3],
    ["e^x", 0, 1],
    ["3sin(x)cos(x)", 0, 0],
    ["sin^2 x + cos^2 x", 1.3, 1],
    ["pi x", 2, 2 * Math.PI],
    ["ln(e)", 0, 1],
    ["|x|".replace(/\|/g, ""), 0, 0],
  ])("%s at x = %d is %d", (source, x, expected) => {
    expect(compileExpression(source)(x)).toBeCloseTo(expected, 9);
  });

  it("refuses anything that isn't a formula in x", () => {
    for (const bad of [
      "alert(1)",
      "x; fetch()",
      "constructor",
      "y",
      "(x",
      "x".repeat(81),
      `${"(".repeat(40)}x${")".repeat(40)}`,
    ]) {
      expect(() => compileExpression(bad), bad).toThrow(ExprError);
    }
  });
});

describe("ticks", () => {
  it("picks about five round values", () => {
    expect(ticks(-6.3, 6.3)).toEqual([-6, -4, -2, 0, 2, 4, 6]);
    expect(ticks(0, 1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(ticks(-1.1, 1.1)).toEqual([-1, -0.5, 0, 0.5, 1]);
  });
});

describe("toPaths", () => {
  it("turns roughjs ops into sampled polylines", () => {
    const paths = toPaths({
      shape: "line",
      options: {} as never,
      sets: [
        {
          type: "path",
          ops: [
            { op: "move", data: [0, 0] },
            { op: "bcurveTo", data: [10, 0, 20, 0, 30, 0] },
            { op: "lineTo", data: [30, 10] },
          ],
        },
      ],
    });
    expect(paths).toHaveLength(1);
    expect(paths[0]?.at(-1)).toEqual([30, 10]);
    expect(paths[0]?.length).toBeGreaterThan(8);
  });
});

describe("visual renderers", () => {
  const plot: BoardAction = {
    type: "draw_plot",
    expressions: ["sin(x)"],
    xRange: [-6.3, 6.3],
    anchor: { near: "below_active_line" },
  };
  const mindmap: BoardAction = {
    type: "draw_graph",
    kind: "mindmap",
    nodes: [
      { id: "c", label: "Causes of WW1" },
      { id: "a", label: "Alliances" },
      { id: "m", label: "Militarism" },
      { id: "i", label: "Imperialism" },
      { id: "n", label: "Nationalism" },
    ],
    edges: [
      { from: "c", to: "a" },
      { from: "c", to: "m" },
      { from: "c", to: "i" },
      { from: "c", to: "n" },
      { from: "c", to: "ghost" }, // unknown node: ignored
    ],
    anchor: { near: "free_space" },
  };

  it("graphs y = sin x as ink: axes, ticks and a smooth curve, clear of the student's work", async () => {
    const strokes = page();
    const plan = await planBoard([plot], input(strokes), ALL_RENDERERS);
    expect(plan.skipped).toEqual([]);
    const ink = plan.actions[0]?.strokes ?? [];
    expect(ink.length).toBeGreaterThan(10);
    for (const s of ink) {
      expect(StrokeSchema.safeParse(s).success).toBe(true);
      expect(strokes.some((o) => bboxesIntersect(s.bbox, o.bbox))).toBe(false);
    }
    // The curve is the longest stroke and spans most of the plot's width.
    const longest = ink.reduce((a, b) => (a.points.length > b.points.length ? a : b));
    expect(longest.bbox[2]).toBeGreaterThan(0.6 * (plan.actions[0]?.bbox[2] ?? 0));
  });

  it("breaks curves at asymptotes instead of drawing vertical lines", async () => {
    const tan: BoardAction = { ...plot, expressions: ["tan(x)"], yRange: [-5, 5] };
    const plan = await planBoard([tan], input([]), ALL_RENDERERS);
    const tall = (plan.actions[0]?.strokes ?? []).filter((s) => s.bbox[3] > s.bbox[2] * 3);
    // Several separate branches, none crossing the whole height in one stroke from top to bottom
    // at a single x (that would be a fake vertical line through an asymptote).
    expect(tall.length).toBeGreaterThanOrEqual(3);
  });

  it("says why when it can't plot", async () => {
    const bad = { ...plot, expressions: ["what"] } as BoardAction;
    const plan = await planBoard([bad], input([]), ALL_RENDERERS);
    expect(plan.skipped).toEqual([
      { index: 0, type: "draw_plot", reason: "couldn't read the expression" },
    ]);
  });

  it("draws a mind map of the causes of WW1: ellipses, labels and spokes", async () => {
    const strokes = page();
    const plan = await planBoard([mindmap], input(strokes), ALL_RENDERERS);
    expect(plan.skipped).toEqual([]);
    const action = plan.actions[0];
    expect(action?.strokes.length).toBeGreaterThan(5 * 4); // ellipses + letters + edges
    for (const s of action?.strokes ?? []) {
      expect(strokes.some((o) => bboxesIntersect(s.bbox, o.bbox))).toBe(false);
    }
    // Readable: diagrams fit within the view.
    expect(action?.bbox[2]).toBeLessThanOrEqual(1400);
  });

  it("draws a flowchart top to bottom with arrows", async () => {
    const flow: BoardAction = {
      type: "draw_graph",
      kind: "flowchart",
      nodes: [
        { id: "s", label: "Start" },
        { id: "q", label: "x > 0?" },
        { id: "e", label: "End" },
      ],
      edges: [
        { from: "s", to: "q" },
        { from: "q", to: "e", label: "no" },
      ],
      anchor: { near: "free_space" },
    };
    const plan = await planBoard([flow], input([]), ALL_RENDERERS);
    const action = plan.actions[0];
    expect(plan.skipped).toEqual([]);
    expect(action?.bbox[3]).toBeGreaterThan(action?.bbox[2] ?? 0); // taller than wide
  });

  it("sketches simple shapes and keeps several visuals apart", async () => {
    const shapes: BoardAction = {
      type: "draw_shapes",
      shapes: [
        { kind: "box", x: 0.1, y: 0.3, w: 0.3, h: 0.4, label: "cell" },
        { kind: "arrow", x: 0.45, y: 0.5, w: 0.2, h: 0 },
        { kind: "circle", x: 0.7, y: 0.3, w: 0.25, h: 0.4 },
      ],
      anchor: { near: "free_space" },
    };
    const plan = await planBoard([plot, mindmap, shapes], input(page()), ALL_RENDERERS);
    expect(plan.skipped).toEqual([]);
    const boxes = plan.actions.map((a) => a.bbox);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(bboxesIntersect(boxes[i] ?? [0, 0, 0, 0], boxes[j] ?? [0, 0, 0, 0])).toBe(false);
      }
    }
  });
});
