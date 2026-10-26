import { PageDocument, strokeBBox, type Vec } from "@mew/ink";
import type { Point, Stroke } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { circledLines, toPage } from "./circle";

let n = 0;
function stroke(x: number, y: number, author: Stroke["author"] = "student"): Stroke {
  const points: Point[] = [
    [x, y + 24, 0.5, 0],
    [x + 8, y, 0.5, 10],
    [x + 16, y + 24, 0.5, 20],
  ];
  n++;
  return {
    id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
    pageId: "00000000-0000-4000-8000-0000000000aa",
    author,
    tool: "pen",
    points,
    color: "#1d1c1a",
    width: 3,
    bbox: strokeBBox(points, 3),
    createdAt: n,
  };
}

const written = (y: number, letters = 4) =>
  Array.from({ length: letters }, (_, i) => stroke(100 + i * 20, y));

/** A rectangle as a hand-drawn loop would be (closed implicitly). */
const loop = (x: number, y: number, w: number, h: number): Vec[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

describe("circledLines", () => {
  it("takes the lines inside the loop, top to bottom", () => {
    const doc = new PageDocument([...written(300), ...written(100), ...written(200)]);
    const lines = circledLines(doc, loop(80, 80, 200, 160));
    expect(lines).toHaveLength(2);
    expect(lines[0]?.bbox[1]).toBeLessThan(lines[1]?.bbox[1] ?? 0);
  });

  it("doesn't take a neighbour the loop only clips", () => {
    const doc = new PageDocument([...written(100), ...written(200)]);
    // All of the first line, and only the first letter of the second.
    const lines = circledLines(doc, loop(80, 80, 200, 60));
    expect(lines).toHaveLength(1);
    const clipped = circledLines(doc, [
      [80, 80],
      [200, 80],
      [200, 140],
      [125, 140],
      [125, 240],
      [80, 240],
    ]);
    expect(clipped).toHaveLength(1);
  });

  it("finds nothing in an empty loop, and never the tutor's ink", () => {
    const doc = new PageDocument([stroke(100, 100, "tutor"), stroke(120, 100, "tutor")]);
    expect(circledLines(doc, loop(80, 80, 200, 60))).toEqual([]);
    expect(circledLines(doc, [[0, 0]])).toEqual([]);
  });
});

describe("toPage", () => {
  it("undoes the camera's zoom and pan", () => {
    expect(toPage([200, 100], { x: 50, y: 20, zoom: 2 })).toEqual([150, 70]);
    expect(toPage([10, 10], { x: 0, y: 0, zoom: 1 })).toEqual([10, 10]);
  });
});
