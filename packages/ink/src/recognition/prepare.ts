import { median } from "../geometry";

/** Anything with points: a page stroke ([x, y, pressure, t]) or a generated polyline ([x, y]). */
export type InkLike = { readonly points: readonly (readonly number[])[] };

/**
 * A line of handwriting made ready for recognition (K10 §8.2 "clean input"): drawn from its
 * stroke vectors, deskewed, scaled so its letters are a fixed size, with one even pen width and
 * a white margin. Coordinates are pixels of the image it will be drawn into.
 */
export type PreparedLine = {
  /** Polylines as flat [x0, y0, x1, y1, …] lists, in pixels. */
  polylines: number[][];
  width: number;
  height: number;
  /** Pen width in pixels, the same for every stroke. */
  penWidth: number;
  /** The rotation removed, in degrees (positive: the line rose to the right). */
  skewDegrees: number;
};

export const RECOGNITION_RENDER = {
  /** Height of a typical stroke (a digit or capital) once scaled: about 3× a page's writing. */
  letterPx: 42,
  padPx: 24,
  penPx: 4,
  maxWidthPx: 2048,
  maxHeightPx: 640,
  /** Skews beyond this are left alone: the "line" is probably not a line. */
  maxSkewDegrees: 15,
} as const;

/** Returns null when there's no ink. */
export function prepareLine(
  strokes: readonly InkLike[],
  options: Partial<typeof RECOGNITION_RENDER> = {},
): PreparedLine | null {
  const o = { ...RECOGNITION_RENDER, ...options };
  const lines = strokes
    .map((s) => s.points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])))
    .filter((pts) => pts.length > 0)
    .map((pts) => pts.map((p) => [p[0] as number, p[1] as number] as const));
  if (lines.length === 0) return null;

  // Deskew: the baseline is fitted through each stroke's lowest point.
  const skew = baselineSlope(lines, o.maxSkewDegrees);
  const angle = -Math.atan(skew);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rotated = lines.map((pts) =>
    pts.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos] as const),
  );

  const letter = letterHeight(rotated);
  const box = bounds(rotated);
  let scale = o.letterPx / letter;
  // Too big for the image: shrink to fit (a long line, or one tall symbol).
  scale = Math.min(
    scale,
    (o.maxWidthPx - 2 * o.padPx) / Math.max(1e-6, box.w),
    (o.maxHeightPx - 2 * o.padPx) / Math.max(1e-6, box.h),
  );
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  const polylines = rotated.map((pts) =>
    pts.flatMap(([x, y]) => [(x - box.x) * scale + o.padPx, (y - box.y) * scale + o.padPx]),
  );
  return {
    polylines,
    width: Math.max(1, Math.ceil(box.w * scale + 2 * o.padPx)),
    height: Math.max(1, Math.ceil(box.h * scale + 2 * o.padPx)),
    penWidth: o.penPx,
    // y grows downwards, so a line rising to the right has a negative slope.
    skewDegrees: skew === 0 ? 0 : (-Math.atan(skew) * 180) / Math.PI,
  };
}

/**
 * The page geometry as it is (the pipeline before K10): no deskew, the line's own size scaled to
 * fit, each stroke's own width. Kept for the eval's baseline.
 */
export function prepareLineAsDrawn(
  strokes: readonly (InkLike & { readonly width?: number })[],
  { maxSidePx = 1024, maxScale = 4, padPx = 8 } = {},
): PreparedLine | null {
  const lines = strokes
    .map((s) => s.points.map((p) => [p[0] as number, p[1] as number] as const))
    .filter((pts) => pts.length > 0);
  if (lines.length === 0) return null;
  const box = bounds(lines);
  const scale = Math.min(maxScale, (maxSidePx - 2 * padPx) / Math.max(box.w, box.h, 1e-6));
  const widths = strokes.filter((s) => s.points.length > 0).map((s) => s.width ?? 2.5);
  return {
    polylines: lines.map((pts) =>
      pts.flatMap(([x, y]) => [(x - box.x) * scale + padPx, (y - box.y) * scale + padPx]),
    ),
    width: Math.max(1, Math.ceil(box.w * scale + 2 * padPx)),
    height: Math.max(1, Math.ceil(box.h * scale + 2 * padPx)),
    penWidth: Math.max(1, median(widths) * scale),
    skewDegrees: 0,
  };
}

type Pts = readonly (readonly [number, number] | readonly number[])[];

/** Slope (dy/dx) of the baseline, 0 when it can't be told or is implausibly steep. */
function baselineSlope(lines: readonly Pts[], maxDegrees: number): number {
  const lows = lines.map((pts) => {
    let low = pts[0] as readonly number[];
    for (const p of pts) if (p[1] > (low[1] as number)) low = p;
    const xs = pts.map((p) => p[0]);
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: low[1] as number };
  });
  if (lows.length < 3) return 0;
  const box = bounds(lines);
  if (box.w < 2 * box.h) return 0; // a short line: its baseline says little
  const mx = lows.reduce((s, p) => s + p.x, 0) / lows.length;
  const my = lows.reduce((s, p) => s + p.y, 0) / lows.length;
  let sxx = 0;
  let sxy = 0;
  for (const p of lows) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  if (sxx === 0) return 0;
  const slope = sxy / sxx;
  return Math.abs(Math.atan(slope)) <= (maxDegrees * Math.PI) / 180 ? slope : 0;
}

/** A typical letter's height: the median of strokes that aren't flat (bars, dots, minus signs). */
function letterHeight(lines: readonly Pts[]): number {
  const heights = lines
    .map((pts) => bounds([pts]))
    .filter((b) => b.h > 0 && b.h >= 0.35 * b.w)
    .map((b) => b.h);
  const rough = median(heights);
  if (rough > 0) {
    const letters = heights.filter((h) => h >= 0.35 * rough && h <= 2.2 * rough);
    const m = median(letters);
    if (m > 0) return m;
  }
  const box = bounds(lines);
  return Math.max(box.h, box.w / 4, 1e-3);
}

function bounds(lines: readonly Pts[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const pts of lines) {
    for (const p of pts) {
      const x = p[0];
      const y = p[1];
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * The order the strokes were written in, as compact text (§8.2: "test whether also sending stroke
 * order helps"): each stroke's start and end in the prepared picture, in tenths of a letter
 * height, "1:(3,9)>(3,0) 2:…". At most `max` strokes.
 */
export function strokeOrderText(line: PreparedLine, max = 60): string {
  const unit = RECOGNITION_RENDER.letterPx / 10;
  const at = (x: number, y: number) =>
    `(${Math.round((x - RECOGNITION_RENDER.padPx) / unit)},${Math.round((y - RECOGNITION_RENDER.padPx) / unit)})`;
  return line.polylines
    .slice(0, max)
    .map((poly, i) => {
      const n = poly.length;
      return `${i + 1}:${at(poly[0] ?? 0, poly[1] ?? 0)}>${at(poly[n - 2] ?? 0, poly[n - 1] ?? 0)}`;
    })
    .join(" ");
}
