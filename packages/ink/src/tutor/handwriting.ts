import type { Stroke } from "@mew/shared";

import { median } from "../geometry";

/** How big the tutor should write, in page units. */
export type HandwritingScale = { xHeight: number; penWidth: number };

/** Used when there's no student writing to match (an empty page). */
export const DEFAULT_HANDWRITING: HandwritingScale = { xHeight: 9, penWidth: 2.5 };

/**
 * A handwritten stroke is typically a letter or digit, so its median height sits between the
 * x-height and the cap height (handwritten maths is mostly digits and capitals).
 */
const STROKE_HEIGHT_IN_X_HEIGHTS = 1.4;
const LIMITS = { minX: 3, maxX: 80, minPen: 1, maxPen: 8 };

/**
 * Estimates the student's writing size from their strokes (ideally their latest lines). Flat
 * strokes (minus signs, bars, dots) and very tall ones (brackets, integrals) are ignored.
 */
export function measureHandwriting(
  strokes: readonly Pick<Stroke, "bbox" | "width">[],
): HandwritingScale {
  // Ink extents (the box includes half the pen width on each side). Flat strokes say nothing
  // about letter height.
  const heights = strokes
    .map((s) => [Math.max(0, s.bbox[2] - s.width), Math.max(0, s.bbox[3] - s.width)] as const)
    .filter(([w, h]) => h > 0 && h >= 0.35 * w)
    .map(([, h]) => h);
  const rough = median(heights);
  if (rough <= 0) return DEFAULT_HANDWRITING;
  const letter = median(heights.filter((h) => h >= 0.35 * rough && h <= 2.2 * rough));
  return {
    xHeight: clamp(letter / STROKE_HEIGHT_IN_X_HEIGHTS, LIMITS.minX, LIMITS.maxX),
    penWidth: clamp(0.9 * median(strokes.map((s) => s.width)), LIMITS.minPen, LIMITS.maxPen),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
