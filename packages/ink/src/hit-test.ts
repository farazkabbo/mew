import type { Point, Stroke } from "@mew/shared";

import { bboxesIntersect, bboxOfPoints, inflateBBox, segmentDistance, type Vec } from "./geometry";

type HitTestable = Pick<Stroke, "points" | "width" | "bbox">;

/** A stroke's bounding box: its centreline points grown by half the stroke width. */
export function strokeBBox(points: readonly Point[], width: number) {
  return bboxOfPoints(points, width / 2);
}

/**
 * Whether an eraser of `radius` moving from `from` to `to` touches the stroke's inked area.
 * Distances are in page units.
 */
export function eraserHitsStroke(stroke: HitTestable, from: Vec, to: Vec, radius: number): boolean {
  const sweep = inflateBBox(
    [
      Math.min(from[0], to[0]),
      Math.min(from[1], to[1]),
      Math.abs(to[0] - from[0]),
      Math.abs(to[1] - from[1]),
    ],
    radius,
  );
  if (!bboxesIntersect(sweep, stroke.bbox)) return false;

  const reach = radius + stroke.width / 2;
  const { points } = stroke;
  const first = points[0];
  if (!first) return false;
  if (points.length === 1) return segmentDistance(from, to, first, first) <= reach;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b && segmentDistance(from, to, a, b) <= reach) return true;
  }
  return false;
}
