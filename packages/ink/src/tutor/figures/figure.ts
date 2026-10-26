import type { BBox } from "@mew/shared";

import type { Path, RoughPen } from "../visuals/rough";

/**
 * A figure ready to ink (K5): hand-drawn paths, paths to go over in the highlighter, and labels
 * to write. Everything is in the caller's pixels; labels are centred on `at` and sized in x-heights
 * relative to `unit`. The notebook and the screen's sketch card ink it their own way.
 */
export type FigureLabel = {
  text: string;
  at: [number, number];
  /** Text size relative to the frame's unit. */
  scale: number;
  /** Written in the highlight's place: drawn in the ink colour, but meant to stand out. */
  accent?: boolean;
};

export type Figure = {
  paths: Path[];
  /** Highlighter strokes over what the tutor wants seen (a side, an atom). */
  accents: Path[];
  labels: FigureLabel[];
};

/** Where a figure goes: its box in pixels, the size unit (about one x-height), a seeded pen. */
export type FigureFrame = { rect: BBox; unit: number; pen: RoughPen };

export type Vec = [number, number];

export const add = (p: Vec, q: Vec): Vec => [p[0] + q[0], p[1] + q[1]];
export const sub = (p: Vec, q: Vec): Vec => [p[0] - q[0], p[1] - q[1]];
export const mul = (p: Vec, k: number): Vec => [p[0] * k, p[1] * k];
export const length = (p: Vec): number => Math.hypot(p[0], p[1]);
export const unit = (p: Vec): Vec => {
  const l = length(p);
  return l === 0 ? [0, 0] : [p[0] / l, p[1] / l];
};
export const lerp = (p: Vec, q: Vec, t: number): Vec => [
  p[0] + (q[0] - p[0]) * t,
  p[1] + (q[1] - p[1]) * t,
];

/**
 * Maps points laid out in any units into `rect`, keeping proportions and leaving `margin` on
 * every side for labels. Returns the mapping and its scale (pixels per layout unit).
 */
export function fitInto(
  points: readonly Vec[],
  [x, y, w, h]: BBox,
  margin: number,
): { map: (p: Vec) => Vec; scale: number } {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const bw = Math.max(Math.max(...xs) - minX, 1e-9);
  const bh = Math.max(Math.max(...ys) - minY, 1e-9);
  const room: Vec = [Math.max(w - 2 * margin, w * 0.3), Math.max(h - 2 * margin, h * 0.3)];
  const scale = Math.min(room[0] / bw, room[1] / bh);
  // Centred in the box.
  const ox = x + (w - bw * scale) / 2;
  const oy = y + (h - bh * scale) / 2;
  return { map: (p) => [ox + (p[0] - minX) * scale, oy + (p[1] - minY) * scale], scale };
}

/** An arc around `centre` from angle `from` sweeping `sweep` radians (y down), as one path. */
export function arc(centre: Vec, radius: number, from: number, sweep: number, steps = 18): Path {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = from + (sweep * i) / steps;
    return [centre[0] + radius * Math.cos(t), centre[1] + radius * Math.sin(t)] as Vec;
  });
}

/** A dashed straight line: short pen strokes with gaps. */
export function dashed(from: Vec, to: Vec, dash: number, pen: RoughPen): Path[] {
  const total = length(sub(to, from));
  const count = Math.max(1, Math.floor(total / (dash * 1.8)));
  const paths: Path[] = [];
  for (let i = 0; i < count; i++) {
    const a = lerp(from, to, (i * 1.8 * dash) / total);
    const b = lerp(from, to, Math.min(1, (i * 1.8 * dash + dash) / total));
    paths.push(...pen.line(a[0], a[1], b[0], b[1]));
  }
  return paths;
}

/** A small filled-looking dot (a tight spiral the pen can draw). */
export function dot(at: Vec, radius: number): Path {
  return Array.from({ length: 13 }, (_, i) => {
    const t = (i / 12) * 2 * Math.PI * 1.5;
    const r = radius * (1 - i / 24);
    return [at[0] + r * Math.cos(t), at[1] + r * Math.sin(t)] as Vec;
  });
}

/** A short trimmed number: 5, 2.5, 7.07. */
export function formatNumber(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}
