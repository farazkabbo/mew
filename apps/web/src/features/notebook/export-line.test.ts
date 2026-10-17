import type { Point, Stroke } from "@mew/shared";
import { PageDocument, strokeBBox } from "@mew/ink";
import { describe, expect, it } from "vitest";

import { studentLines } from "./export-line";

function stroke(overrides: Partial<Stroke>, y: number, createdAt: number): Stroke {
  const points: Point[] = [
    [0, y, 0.5, 0],
    [40, y + 10, 0.5, 20],
  ];
  return {
    id: crypto.randomUUID(),
    pageId: crypto.randomUUID(),
    author: "student",
    tool: "pen",
    points,
    color: "#1d1c1a",
    width: 2,
    bbox: strokeBBox(points, 2),
    createdAt,
    ...overrides,
  };
}

describe("studentLines", () => {
  it("segments handwriting but ignores highlighter marks and tutor ink", () => {
    const writing = stroke({}, 100, 1);
    const highlight = stroke({ tool: "highlighter", width: 18 }, 100, 2);
    const tutor = stroke({ author: "tutor" }, 300, 3);
    const lines = studentLines(new PageDocument([writing, highlight, tutor]));

    expect(lines).toHaveLength(1);
    expect(lines[0]?.strokeIds).toEqual([writing.id]);
  });
});
