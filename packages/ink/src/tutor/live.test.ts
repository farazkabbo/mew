import { type BBox, Stroke as StrokeSchema, type Stroke } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { bboxesIntersect } from "../geometry";
import { segmentLines } from "../segmentation";
import { strokeThrough, testId } from "../test-helpers";
import type { BoardInput } from "./board";
import { dashes, planLiveMarkInk } from "./live";

const COLORS = { ink: "#8a7bf0", error: "#c8432b", correct: "#2f7d55" };

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

function input(strokes: Stroke[]): BoardInput {
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
  };
}

const page = [...writeLine(100, 100, 8, 24, 0), ...writeLine(100, 170, 6, 24, 100)];
const board = input(page);
const second = board.lines[1];
if (!second) throw new Error("two lines expected");

const inside = (inner: BBox, outer: BBox) =>
  inner[0] >= outer[0] &&
  inner[1] >= outer[1] &&
  inner[0] + inner[2] <= outer[0] + outer[2] &&
  inner[1] + inner[3] <= outer[1] + outer[3];

describe("live annotations' ink (K9 §7.1)", () => {
  it("circles just the wrong part and writes the hint in the margin, as marks", () => {
    const [x, y, w, h] = second.bbox;
    const focus: BBox = [x + w * 0.6, y, w * 0.4, h];
    const ink = planLiveMarkInk({ kind: "error", note: "sign?", lineId: second.id, focus }, board);
    if (!ink) throw new Error("no ink");
    expect(ink.strokes.every((s) => s.markKind === "error" && s.author === "tutor")).toBe(true);
    expect(ink.strokes.every((s) => StrokeSchema.safeParse(s).success)).toBe(true);
    const loop = ink.strokes.find((s) => s.points.length > 40);
    if (!loop) throw new Error("no loop");
    // Round the focus, not the whole line: it starts right of the line's first letters.
    expect(loop.bbox[0]).toBeGreaterThan(x + w * 0.4);
    // The hint is tapped, not the loop; it sits right of the line, off the student's ink.
    expect(ink.hitBox[0]).toBeGreaterThan(x + w);
    for (const stroke of page) expect(bboxesIntersect(ink.hitBox, stroke.bbox)).toBe(false);
  });

  it("puts a small tick after the line", () => {
    const ink = planLiveMarkInk({ kind: "tick", note: null, lineId: second.id }, board);
    if (!ink) throw new Error("no ink");
    expect(ink.strokes).toHaveLength(1);
    expect(ink.strokes[0]?.color).toBe(COLORS.correct);
    expect(ink.bbox[0]).toBeGreaterThan(second.bbox[0] + second.bbox[2]);
    expect(inside(ink.bbox, ink.hitBox)).toBe(true);
  });

  it("draws the ? in dashes, and a missing unit with an underline", () => {
    const unsure = planLiveMarkInk({ kind: "unsure", note: "?", lineId: second.id }, board);
    const plain = planLiveMarkInk({ kind: "margin", note: "?", lineId: second.id }, board);
    if (!unsure || !plain) throw new Error("no ink");
    expect(unsure.strokes.length).toBeGreaterThan(2);
    expect(unsure.strokes.every((s) => s.markKind === "unsure")).toBe(true);
    const missing = planLiveMarkInk({ kind: "missing", note: "units?", lineId: second.id }, board);
    if (!missing) throw new Error("no ink");
    const underline = missing.strokes.reduce((a, b) => (a.bbox[2] > b.bbox[2] ? a : b));
    expect(underline.bbox[1]).toBeGreaterThan(second.bbox[1] + second.bbox[3] - 2);
  });

  it("draws nothing for a line that isn't there", () => {
    expect(planLiveMarkInk({ kind: "tick", note: null, lineId: "nope" }, board)).toBeNull();
  });

  it("cuts a stroke into dashes with ids of their own", () => {
    const long = strokeThrough(
      [
        [0, 0],
        [100, 0],
      ],
      { width: 2 },
    );
    const cut = dashes(
      { ...long, points: Array.from({ length: 21 }, (_, i) => [i * 5, 0, 0.5, i]) },
      10,
      () => testId(),
    );
    expect(cut.length).toBeGreaterThan(3);
    expect(new Set(cut.map((s) => s.id)).size).toBe(cut.length);
  });
});
