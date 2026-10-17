import type { BBox, Point, Stroke } from "@mew/shared";

import { strokeBBox } from "./hit-test";

const PAGE_ID = "00000000-0000-4000-8000-000000000001";
let counter = 0;

/** Deterministic UUID-shaped ids for tests. */
export function testId(n = ++counter): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** A pen stroke through the given points (pressure 0.5, 10 ms apart). */
export function strokeThrough(
  coords: readonly (readonly [number, number])[],
  overrides: Partial<Stroke> = {},
): Stroke {
  const points: Point[] = coords.map(([x, y], i) => [x, y, 0.5, i * 10]);
  const width = overrides.width ?? 2;
  return {
    id: testId(),
    pageId: PAGE_ID,
    author: "student",
    tool: "pen",
    points,
    color: "#1d1c1a",
    width,
    bbox: strokeBBox(points, width),
    createdAt: 0,
    ...overrides,
  };
}

/** A stroke reduced to what segmentation looks at: a box and a time. */
export function boxStroke(bbox: BBox, createdAt: number) {
  return { id: testId(), bbox, createdAt };
}
