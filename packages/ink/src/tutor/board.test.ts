import type { Anchor, BoardAction, Stroke } from "@mew/shared";
import { Stroke as StrokeSchema } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { bboxesIntersect } from "../geometry";
import { segmentLines } from "../segmentation";
import { strokeThrough, testId } from "../test-helpers";
import { TEXT_RENDERERS } from "./actions";
import { type BoardInput, planBoard, relocateAction } from "./board";
import { DEFAULT_HANDWRITING, measureHandwriting } from "./handwriting";
import { inkify } from "./inkify";
import { seededRandom } from "./random";
import { typesetLatex } from "./typeset/latex-layout";

const COLORS = { ink: "#8a7bf0", error: "#c8432b", correct: "#2f7d55" };

/** A line of handwriting: `letters` zig-zag strokes `height` tall starting at (x, y). */
function writeLine(x: number, y: number, letters: number, height: number, t0: number): Stroke[] {
  return Array.from({ length: letters }, (_, i) =>
    strokeThrough(
      [
        [x + i * height, y + height],
        [x + i * height + height * 0.3, y],
        [x + i * height + height * 0.6, y + height],
      ],
      { createdAt: t0 + i, width: 3 },
    ),
  );
}

function input(strokes: Stroke[], overrides: Partial<BoardInput> = {}): BoardInput {
  const lines = segmentLines(strokes);
  return {
    pageId: testId(),
    groupId: testId(),
    strokes,
    lines,
    activeLine: lines.at(-1),
    viewport: [0, 0, 1200, 900],
    colors: COLORS,
    now: 10_000,
    newId: () => testId(),
    ...overrides,
  };
}

const studentPage = () => [...writeLine(100, 100, 10, 24, 0), ...writeLine(100, 170, 8, 24, 100)];

describe("measureHandwriting", () => {
  it("derives the x-height from typical letter strokes, ignoring bars and tall strokes", () => {
    const strokes = writeLine(0, 0, 9, 28, 0);
    strokes.push(
      strokeThrough(
        [
          [0, 50],
          [80, 50],
        ],
        { width: 3 },
      ),
    ); // a fraction bar
    strokes.push(
      strokeThrough(
        [
          [0, 0],
          [0, 200],
        ],
        { width: 3 },
      ),
    ); // a tall bracket
    const scale = measureHandwriting(strokes);
    expect(scale.xHeight).toBeCloseTo(20, 0);
    expect(scale.penWidth).toBeCloseTo(2.7);
  });

  it("falls back to defaults with nothing to measure", () => {
    expect(measureHandwriting([])).toEqual(DEFAULT_HANDWRITING);
  });
});

describe("inkify", () => {
  it("positions, scales and times strokes like handwriting", () => {
    const box = typesetLatex("x").box;
    const strokes = inkify(box, [100, 200], { xHeight: 10, rng: seededRandom(1), jitter: 0 });
    expect(strokes).toHaveLength(2); // x is two strokes
    const ys = strokes.flat().map((p) => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(190, 0); // one x-height above the baseline
    expect(Math.max(...ys)).toBeCloseTo(200, 0);
    for (const points of strokes) {
      expect(points[0]?.[3]).toBe(0);
      expect(points.at(-1)?.[3]).toBeGreaterThan(0);
      expect(points.every((p) => p[2] > 0 && p[2] <= 1)).toBe(true);
    }
  });

  it("is deterministic for a seed and varies between seeds", () => {
    const box = typesetLatex("abc").box;
    const a = inkify(box, [0, 0], { xHeight: 10, rng: seededRandom(7) });
    const b = inkify(box, [0, 0], { xHeight: 10, rng: seededRandom(7) });
    const c = inkify(box, [0, 0], { xHeight: 10, rng: seededRandom(8) });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe("planBoard", () => {
  const write = (latex: string, anchor: Anchor): BoardAction => ({
    type: "write_math",
    latex,
    anchor,
  });

  it("writes an equation next to the line, at the student's size, without overlapping", async () => {
    const strokes = studentPage();
    const plan = await planBoard(
      [write("F_1 = -F_2", { near: "active_line" })],
      input(strokes),
      TEXT_RENDERERS,
    );

    expect(plan.skipped).toEqual([]);
    const ink = plan.actions[0]?.strokes ?? [];
    expect(ink.length).toBeGreaterThan(4);
    for (const t of ink) expect(strokes.some((s) => bboxesIntersect(t.bbox, s.bbox))).toBe(false);

    // Same size as the student's writing: measured the same way, within ±35%.
    const ratio = measureHandwriting(ink).xHeight / measureHandwriting(strokes).xHeight;
    expect(ratio).toBeGreaterThan(0.65);
    expect(ratio).toBeLessThan(1.35);

    // Next to the active (second) line: same band, to its right.
    const line = segmentLines(strokes).at(-1)?.bbox ?? [0, 0, 0, 0];
    const box = plan.actions[0]?.bbox ?? [0, 0, 0, 0];
    expect(box[0]).toBeGreaterThan(line[0] + line[2]);
    expect(box[1]).toBeLessThan(line[1] + line[3]);
    expect(box[1] + box[3]).toBeGreaterThan(line[1]);
  });

  it("produces valid tutor strokes that share the turn's group", async () => {
    const base = input(studentPage());
    const plan = await planBoard(
      [
        write("x^2", { near: "below_active_line" }),
        { type: "write_text", text: "nice", anchor: { near: "free_space" } },
      ],
      base,
      TEXT_RENDERERS,
    );
    const all = plan.actions.flatMap((a) => a.strokes);
    for (const stroke of all) {
      expect(StrokeSchema.safeParse(stroke).success).toBe(true);
      expect(stroke).toMatchObject({ author: "tutor", groupId: base.groupId, color: COLORS.ink });
    }
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
  });

  it("keeps several actions in one turn apart from each other", async () => {
    const plan = await planBoard(
      [
        write("a+b", { near: "below_active_line" }),
        write("c+d", { near: "below_active_line" }),
        write("e+f", { near: "below_active_line" }),
      ],
      input(studentPage()),
      TEXT_RENDERERS,
    );
    const boxes = plan.actions.map((a) => a.bbox);
    expect(boxes).toHaveLength(3);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(bboxesIntersect(boxes[i] ?? [0, 0, 0, 0], boxes[j] ?? [0, 0, 0, 0])).toBe(false);
      }
    }
  });

  it("circles a wrong line in the error colour and notes why beside it", async () => {
    const strokes = studentPage();
    const target = segmentLines(strokes)[0];
    const plan = await planBoard(
      [{ type: "mark_error", targetLineId: target?.id ?? "", note: "sign?" }],
      input(strokes),
      TEXT_RENDERERS,
    );
    const ink = plan.actions[0]?.strokes ?? [];
    expect(ink.every((s) => s.color === COLORS.error)).toBe(true);
    const loop = ink[0]?.bbox ?? [0, 0, 0, 0];
    const line = target?.bbox ?? [0, 0, 0, 0];
    expect(loop[0]).toBeLessThan(line[0]);
    expect(loop[0] + loop[2]).toBeGreaterThan(line[0] + line[2]);
    // The note itself doesn't cover any student writing.
    for (const t of ink.slice(1))
      expect(strokes.some((s) => bboxesIntersect(t.bbox, s.bbox))).toBe(false);
  });

  it("ticks a correct line and skips marks for lines that don't exist", async () => {
    const strokes = studentPage();
    const line = segmentLines(strokes)[1];
    const plan = await planBoard(
      [
        { type: "mark_correct", targetLineId: line?.id ?? "" },
        { type: "mark_correct", targetLineId: "line_nope" },
      ],
      input(strokes),
      TEXT_RENDERERS,
    );
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.strokes[0]?.color).toBe(COLORS.correct);
    expect(plan.skipped).toEqual([{ index: 1, type: "mark_correct", reason: "unknown line" }]);
  });

  it("reports actions it has no renderer for", async () => {
    const plan = await planBoard(
      [
        {
          type: "draw_plot",
          expressions: ["sin(x)"],
          xRange: [0, 6],
          anchor: { near: "free_space" },
        },
      ],
      input(studentPage()),
      TEXT_RENDERERS,
    );
    expect(plan.skipped).toEqual([{ index: 0, type: "draw_plot", reason: "not supported yet" }]);
  });

  it("writes on an empty page at the default size, on screen", async () => {
    const plan = await planBoard(
      [write("y = mx + c", { near: "below_active_line" })],
      input([]),
      TEXT_RENDERERS,
    );
    expect(plan.scale).toEqual(DEFAULT_HANDWRITING);
    const box = plan.actions[0]?.bbox ?? [0, 0, 0, 0];
    expect(box[0]).toBeGreaterThanOrEqual(0);
    expect(box[1]).toBeGreaterThanOrEqual(0);
    expect(box[0] + box[2]).toBeLessThanOrEqual(1200);
  });
});

describe("relocateAction", () => {
  it("leaves ink that still fits alone and moves ink the student has written over", async () => {
    const strokes = studentPage();
    const plan = await planBoard(
      [{ type: "write_text", text: "try again", anchor: { near: "below_active_line" } }],
      input(strokes),
      TEXT_RENDERERS,
    );
    const action = plan.actions[0];
    if (!action) throw new Error("nothing planned");
    expect(relocateAction(action, input(strokes))).toBe(action);

    const [x, y, w, h] = action.bbox;
    const scribble = strokeThrough(
      [
        [x, y],
        [x + w, y + h],
      ],
      { createdAt: 500, width: 3 },
    );
    const moved = relocateAction(action, input([...strokes, scribble]));
    expect(moved.bbox).not.toEqual(action.bbox);
    for (const s of moved.strokes) {
      expect([...strokes, scribble].some((o) => bboxesIntersect(s.bbox, o.bbox))).toBe(false);
    }
  });
});
