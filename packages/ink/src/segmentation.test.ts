import { describe, expect, it } from "vitest";

import { currentLine, segmentLines } from "./segmentation";
import { boxStroke } from "./test-helpers";

/** A handwritten word: `letters` strokes of height 20 starting at x, on a baseline at y. */
function word(x: number, y: number, letters: number, startTime: number) {
  return Array.from({ length: letters }, (_, i) =>
    boxStroke([x + i * 14, y - 20 + (i % 2) * 3, 12, 20], startTime + i * 300),
  );
}

describe("segmentLines", () => {
  it("returns nothing for an empty page", () => {
    expect(segmentLines([])).toEqual([]);
  });

  it("groups the strokes of one written line", () => {
    const strokes = [...word(0, 100, 5, 0), ...word(90, 100, 4, 2000)];
    const lines = segmentLines(strokes);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.strokeIds).toHaveLength(9);
  });

  it("separates lines written one below the other, ordered top to bottom", () => {
    const first = word(0, 100, 4, 0);
    const second = word(0, 160, 4, 10_000);
    const lines = segmentLines([...second, ...first]);

    expect(lines.map((l) => l.strokeIds.length)).toEqual([4, 4]);
    expect(lines[0]?.strokeIds).toEqual(first.map((s) => s.id));
  });

  it("keeps a tall symbol in its line without merging the neighbouring lines", () => {
    const above = word(40, 60, 4, 0);
    const integral = boxStroke([0, 70, 14, 70], 5000); // spans well beyond one letter height
    const middle = word(20, 120, 4, 5300);
    const below = word(40, 180, 4, 10_000);
    const lines = segmentLines([...above, integral, ...middle, ...below]);

    expect(lines).toHaveLength(3);
    expect(lines[1]?.strokeIds).toContain(integral.id);
    expect(lines[1]?.strokeIds).toHaveLength(5);
  });

  it("attaches a flat stroke such as a minus sign to its line", () => {
    const strokes = [
      ...word(0, 100, 3, 0),
      boxStroke([50, 89, 12, 1], 1200),
      ...word(70, 100, 2, 1500),
    ];

    expect(segmentLines(strokes)).toHaveLength(1);
  });

  it("does not join strokes that are far apart horizontally (two columns)", () => {
    const left = word(0, 100, 3, 0);
    const right = word(600, 100, 3, 100_000);

    expect(segmentLines([...left, ...right])).toHaveLength(2);
  });

  it("is tolerant of slight baseline drift when writing continuously", () => {
    const drifting = Array.from({ length: 8 }, (_, i) =>
      boxStroke([i * 14, 80 + i * 4, 12, 20], i * 200),
    );

    expect(segmentLines(drifting)).toHaveLength(1);
  });

  it("derives a stable id from the line's earliest stroke", () => {
    const strokes = word(0, 100, 3, 0);
    const before = segmentLines(strokes)[0]?.id;
    const after = segmentLines([...strokes, ...word(50, 100, 2, 5000)])[0]?.id;

    expect(before).toBe(`line_${strokes[0]?.id ?? ""}`);
    expect(after).toBe(before);
  });
});

describe("currentLine", () => {
  it("is the line written in most recently, not the lowest one", () => {
    const top = word(0, 100, 3, 50_000);
    const bottom = word(0, 200, 3, 0);
    const lines = segmentLines([...top, ...bottom]);

    expect(currentLine(lines)?.strokeIds).toEqual(top.map((s) => s.id));
  });

  it("is undefined without lines", () => {
    expect(currentLine([])).toBeUndefined();
  });
});
