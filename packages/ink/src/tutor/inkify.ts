import type { Point } from "@mew/shared";

import { signed } from "./random";
import type { Box, Polyline } from "./typeset/box";

export type InkStyle = {
  /** Page units per x-height. */
  xHeight: number;
  rng: () => number;
  /** 0 = machine-perfect, 1 = the default amount of hand wobble. */
  jitter?: number;
  /** Writing speed in x-heights per second. */
  speed?: number;
};

const ROTATION = (2.5 * Math.PI) / 180;
const SCALE_WOBBLE = 0.03;
const BASELINE_WOBBLE = 0.05;
const DEFAULT_SPEED = 14;
/** Maximum distance between consecutive points, in x-heights (smooth outlines need density). */
const STEP = 0.15;
const MIN_STROKE_MS = 40;

/**
 * Converts a typeset box into pen strokes on the page: positioned with its baseline-left corner
 * at `origin`, scaled to the student's x-height, wobbled per mark so it looks handwritten, and
 * timed at a natural writing speed (each point's t is ms since its stroke began).
 */
export function inkify(box: Box, origin: readonly [number, number], style: InkStyle): Point[][] {
  const { xHeight: size, rng } = style;
  const amount = style.jitter ?? 1;
  const speed = ((style.speed ?? DEFAULT_SPEED) * size) / 1000; // page units per ms
  const result: Point[][] = [];

  for (const mark of box.marks) {
    const angle = signed(rng) * ROTATION * amount;
    const scale = 1 + signed(rng) * SCALE_WOBBLE * amount;
    const lift = signed(rng) * BASELINE_WOBBLE * amount;
    const [px, py] = mark.pivot;
    const cos = Math.cos(angle) * scale;
    const sin = Math.sin(angle) * scale;
    const toPage = (x: number, y: number): [number, number] => {
      const dx = x - px;
      const dy = y - py;
      return [
        origin[0] + (px + dx * cos - dy * sin) * size,
        origin[1] + (py + dx * sin + dy * cos + lift) * size,
      ];
    };
    for (const polyline of mark.strokes) {
      const points = timed(densify(polyline, toPage, STEP * size), speed);
      if (points.length > 0) result.push(points);
    }
  }
  return result;
}

function densify(
  polyline: Polyline,
  toPage: (x: number, y: number) => [number, number],
  step: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < polyline.length; i += 2) {
    const next = toPage(polyline[i] ?? 0, polyline[i + 1] ?? 0);
    const prev = out.at(-1);
    if (prev) {
      const n = Math.ceil(Math.hypot(next[0] - prev[0], next[1] - prev[1]) / step);
      for (let k = 1; k < n; k++) {
        out.push([
          prev[0] + ((next[0] - prev[0]) * k) / n,
          prev[1] + ((next[1] - prev[1]) * k) / n,
        ]);
      }
    }
    out.push(next);
  }
  // A single-point stroke (a dot) gets a tiny second point so it renders as a dot.
  const only = out[0];
  if (out.length === 1 && only) out.push([only[0] + step / 4, only[1] + step / 4]);
  return out;
}

/** Adds pressure (lighter at the ends, like a real pen) and timestamps. */
function timed(points: [number, number][], speed: number): Point[] {
  let length = 0;
  const along = points.map((p, i) => {
    const prev = points[i - 1];
    if (prev) length += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    return length;
  });
  const duration = Math.max(MIN_STROKE_MS, length / speed);
  return points.map(([x, y], i) => {
    const u = length > 0 ? (along[i] ?? 0) / length : 0;
    return [
      round(x),
      round(y),
      round(0.42 + 0.2 * Math.sin(Math.PI * u), 3),
      Math.round(u * duration),
    ];
  });
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
