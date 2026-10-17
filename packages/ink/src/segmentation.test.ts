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

  it("keeps a stacked fraction (numerator, bar, denominator) on its line", () => {
    const lhs = word(0, 110, 2, 0); // "x =" centred on y = 100
    const bar = boxStroke([50, 99, 70, 2], 1000);
    const numerator = word(60, 92, 3, 20_000); // written later, sitting just above the bar
    const denominator = word(65, 128, 2, 40_000); // just below the bar
    const nextLine = word(0, 200, 4, 60_000);

    const lines = segmentLines([...lhs, bar, ...numerator, ...denominator, ...nextLine]);

    expect(lines).toHaveLength(2);
    expect(lines[0]?.strokeIds).toHaveLength(2 + 1 + 3 + 2);
    expect(lines[1]?.strokeIds).toEqual(nextLine.map((s) => s.id));
  });

  it("does not pull the next line into an underlined line", () => {
    const text = word(0, 100, 6, 0);
    const underline = boxStroke([0, 104, 90, 2], 3000);
    const nextLine = word(0, 160, 3, 10_000);

    expect(segmentLines([...text, underline, ...nextLine])).toHaveLength(2);
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
