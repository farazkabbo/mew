import type { Point, Stroke } from "@mew/shared";
import { getStroke, type StrokeOptions } from "perfect-freehand";

type Outlinable = Pick<Stroke, "points" | "width" | "tool">;

/** Pressure stored for input devices that don't report it (mouse, most touch screens). */
export const DEFAULT_PRESSURE = 0.5;

function optionsFor(stroke: Outlinable, complete: boolean): StrokeOptions {
  if (stroke.tool === "highlighter") {
    return { size: stroke.width, thinning: 0, smoothing: 0.6, streamline: 0.6, last: complete };
  }
  return {
    size: stroke.width,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure: !hasRealPressure(stroke.points),
    start: { taper: 0, cap: true },
    end: { taper: 0, cap: true },
    last: complete,
  };
}

export function hasRealPressure(points: readonly Point[]): boolean {
  return points.some(([, , pressure]) => pressure !== DEFAULT_PRESSURE);
}

/**
 * SVG path data for a stroke's filled outline (usable with `new Path2D(d)` or an SVG `<path>`).
 * Pass `complete: false` while the stroke is still being drawn.
 */
export function strokePath(stroke: Outlinable, complete = true): string {
  const outline = getStroke(stroke.points, optionsFor(stroke, complete));
  return outlineToPath(outline);
}

/** Smooth closed path through outline points, using quadratic curves between midpoints. */
export function outlineToPath(outline: readonly (readonly number[])[]): string {
  const n = outline.length;
  if (n < 2) return "";
  const at = (i: number) => outline[i % n] ?? [0, 0];
  const fmt = (v: number | undefined) => (v ?? 0).toFixed(2);

  const [x0, y0] = at(0);
  const [x1, y1] = at(1);
  let d = `M${fmt(x0)},${fmt(y0)} Q${fmt(x1)},${fmt(y1)} ${fmt(avg(x1, at(2)[0]))},${fmt(avg(y1, at(2)[1]))} T`;
  for (let i = 2; i < n - 1; i++) {
    const [ax, ay] = at(i);
    const [bx, by] = at(i + 1);
    d += `${fmt(avg(ax, bx))},${fmt(avg(ay, by))} `;
  }
  return `${d}Z`;
}

function avg(a: number | undefined, b: number | undefined): number {
  return ((a ?? 0) + (b ?? 0)) / 2;
}
