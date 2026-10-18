import { glyph } from "../glyphs/font";

/** A polyline as a flat [x0, y0, x1, y1, …] list. */
export type Polyline = readonly number[];

/**
 * One thing a hand would write as a unit (a glyph, a fraction bar, a radical). Jitter is applied
 * per mark, around its pivot, so each letter wobbles on its own.
 */
export type Mark = { strokes: readonly Polyline[]; pivot: readonly [number, number] };

/**
 * Typeset content in x-height units: origin on the baseline at the left edge, y down. `ascent`
 * and `descent` are the extents above and below the baseline (both ≥ 0).
 */
export type Box = {
  width: number;
  ascent: number;
  descent: number;
  marks: readonly Mark[];
};

export const EMPTY: Box = { width: 0, ascent: 0, descent: 0, marks: [] };

export function space(width: number): Box {
  return { ...EMPTY, width };
}

/** A character's box at `scale`; null when the font has no glyph for it. */
export function glyphBox(ch: string, scale = 1): Box | null {
  const g = glyph(ch);
  if (!g) return null;
  let ascent = 0;
  let descent = 0;
  const strokes = g.strokes.map((flat) =>
    flat.map((v, i) => {
      const scaled = v * scale;
      if (i % 2 === 1) {
        ascent = Math.max(ascent, -scaled);
        descent = Math.max(descent, scaled);
      }
      return scaled;
    }),
  );
  return {
    width: g.advance * scale,
    ascent,
    descent,
    marks: strokes.length ? [{ strokes, pivot: [(g.advance * scale) / 2, 0] }] : [],
  };
}

/** A mark made of free-hand polylines (e.g. a fraction bar), already in box coordinates. */
export function drawn(strokes: Polyline[], box: Omit<Box, "marks">): Box {
  const xs = strokes.flatMap((s) => s.filter((_, i) => i % 2 === 0));
  const pivot: [number, number] = [xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0, 0];
  return { ...box, marks: [{ strokes, pivot }] };
}

export function translate(box: Box, dx: number, dy: number): Box {
  if (dx === 0 && dy === 0) return box;
  return {
    ...box,
    marks: box.marks.map((m) => ({
      strokes: m.strokes.map((s) => s.map((v, i) => v + (i % 2 === 0 ? dx : dy))),
      pivot: [m.pivot[0] + dx, m.pivot[1] + dy],
    })),
  };
}

/** Marks of `box` moved by (dx, dy), for composing into a parent box. */
export function placed(box: Box, dx: number, dy: number): readonly Mark[] {
  return translate(box, dx, dy).marks;
}

/** Boxes side by side on a shared baseline. */
export function hbox(boxes: readonly Box[], gap = 0): Box {
  let x = 0;
  let ascent = 0;
  let descent = 0;
  const marks: Mark[] = [];
  boxes.forEach((b, i) => {
    if (i > 0) x += gap;
    marks.push(...placed(b, x, 0));
    x += b.width;
    ascent = Math.max(ascent, b.ascent);
    descent = Math.max(descent, b.descent);
  });
  return { width: x, ascent, descent, marks };
}

/** Lines stacked top to bottom, left-aligned, `leading` apart (baseline to baseline). */
export function vstack(lines: readonly Box[], leading: number): Box {
  const marks: Mark[] = [];
  let width = 0;
  lines.forEach((line, i) => {
    marks.push(...placed(line, 0, i * leading));
    width = Math.max(width, line.width);
  });
  const first = lines[0];
  const last = lines.at(-1);
  if (!first || !last) return EMPTY;
  return {
    width,
    ascent: first.ascent,
    descent: (lines.length - 1) * leading + last.descent,
    marks,
  };
}

/** Number of points over all strokes (a cost measure for caps). */
export function pointCount(box: Box): number {
  return box.marks.reduce((n, m) => n + m.strokes.reduce((k, s) => k + s.length / 2, 0), 0);
}
