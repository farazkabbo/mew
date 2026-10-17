import type { BBox, Stroke } from "@mew/shared";

import { bboxOfPoints, type Vec } from "./geometry";

/** Even–odd ray casting. The polygon is implicitly closed. */
export function pointInPolygon(x: number, y: number, polygon: readonly Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (!a || !b) continue;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

/** Bounding box of a lasso path. */
export function polygonBBox(polygon: readonly Vec[]): BBox {
  return bboxOfPoints(polygon.map(([x, y]) => [x, y, 0, 0] as const));
}

/**
 * Whether a lasso captures a stroke: at least `minFraction` of its points lie inside. A fraction
 * (rather than "all points") forgives a loop that clips a stroke's tail.
 */
export function lassoCaptures(stroke: Stroke, polygon: readonly Vec[], minFraction = 0.6): boolean {
  if (polygon.length < 3) return false;
  let inside = 0;
  for (const [x, y] of stroke.points) if (pointInPolygon(x, y, polygon)) inside++;
  return inside / stroke.points.length >= minFraction;
}

/** The same stroke (same id) shifted by (dx, dy). */
export function translateStroke(stroke: Stroke, dx: number, dy: number): Stroke {
  const [x, y, w, h] = stroke.bbox;
  return {
    ...stroke,
    points: stroke.points.map(([px, py, pressure, t]) => [px + dx, py + dy, pressure, t]),
    bbox: [x + dx, y + dy, w, h],
  };
}
