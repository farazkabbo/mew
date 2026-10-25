/**
 * What the draw overlay shows (Circle & Ask), as Rust sends it: the student's marks (CSS pixels
 * of the overlay), whether they're grey (this app can't be looked at), whether draw mode is on,
 * and the mode. Checked by hand: the page stays small.
 */

export type Pt = [number, number];
export type Rect = [number, number, number, number];
export type DrawMark = { number: number; points: Pt[] };
/** "keyboard": silent mode's keyboard drawing (§4): pick text blocks, or grow a box. */
export type DrawMode = "draw" | "select" | "keyboard";
export type DrawView = {
  marks: DrawMark[];
  grey: boolean;
  drawing: boolean;
  mode: DrawMode;
  /** Keyboard drawing: the screen's text blocks, nearest the pointer first, and the pointer. */
  blocks: Rect[];
  pointer: Pt | null;
};

const MAX_MARKS = 3;
export const MAX_POINTS = 5_000;

/** The view (fields that are missing keep their old value), or null for anything malformed. */
export function parseDrawView(detail: unknown): (Partial<DrawView> & { mode: DrawMode }) | null {
  if (typeof detail !== "object" || detail === null) return null;
  const { marks, grey, drawing, mode, blocks, pointer } = detail as Record<string, unknown>;
  if (mode !== "draw" && mode !== "select" && mode !== "keyboard") return null;
  const out: Partial<DrawView> & { mode: DrawMode } = { mode };
  if (marks !== undefined) {
    if (!Array.isArray(marks) || marks.length > MAX_MARKS) return null;
    const parsed: DrawMark[] = [];
    for (const mark of marks) {
      const m = mark as { number?: unknown; points?: unknown };
      if (
        !Number.isInteger(m.number) ||
        (m.number as number) < 1 ||
        (m.number as number) > MAX_MARKS
      ) {
        return null;
      }
      if (!Array.isArray(m.points) || m.points.length > MAX_POINTS) return null;
      const points: Pt[] = [];
      for (const p of m.points) {
        if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => Number.isFinite(v))) return null;
        points.push([p[0] as number, p[1] as number]);
      }
      parsed.push({ number: m.number as number, points });
    }
    out.marks = parsed;
  }
  if (grey !== undefined) {
    if (typeof grey !== "boolean") return null;
    out.grey = grey;
  }
  if (drawing !== undefined) {
    if (typeof drawing !== "boolean") return null;
    out.drawing = drawing;
  }
  if (blocks !== undefined) {
    if (!Array.isArray(blocks) || blocks.length > 40) return null;
    const rects: Rect[] = [];
    for (const b of blocks) {
      const rect = numbers(b, 4);
      if (!rect) return null;
      const [x = 0, y = 0, w = 0, h = 0] = rect;
      rects.push([x, y, w, h]);
    }
    out.blocks = rects;
  }
  if (pointer !== undefined && pointer !== null) {
    const point = numbers(pointer, 2);
    if (!point) return null;
    const [x = 0, y = 0] = point;
    out.pointer = [x, y];
  }
  return out;
}

/** Points of the mouse stroke being drawn (Rust reads the mouse); `start` begins a new one. */
export type DrawLive = { start: boolean; points: Pt[] };

export function parseLive(detail: unknown): DrawLive | null {
  if (typeof detail !== "object" || detail === null) return null;
  const { start, points } = detail as Record<string, unknown>;
  if (typeof start !== "boolean" || !Array.isArray(points) || points.length > MAX_POINTS) {
    return null;
  }
  const parsed: Pt[] = [];
  for (const p of points) {
    const point = numbers(p, 2);
    if (!point) return null;
    const [x = 0, y = 0] = point;
    parsed.push([x, y]);
  }
  return { start, points: parsed };
}

/** The question box being dragged with the mouse: from where the drag began to the cursor. */
export function parseBox(detail: unknown): { from: Pt; to: Pt } | null {
  if (typeof detail !== "object" || detail === null) return null;
  const { from, to } = detail as Record<string, unknown>;
  const a = numbers(from, 2);
  const b = numbers(to, 2);
  if (!a || !b) return null;
  return { from: [a[0] ?? 0, a[1] ?? 0], to: [b[0] ?? 0, b[1] ?? 0] };
}

/** `value` if it's exactly `length` finite numbers. */
function numbers(value: unknown, length: number): number[] | null {
  const ok =
    Array.isArray(value) &&
    value.length === length &&
    value.every((v) => typeof v === "number" && Number.isFinite(v));
  return ok ? (value as number[]) : null;
}

/** A rectangle as a closed path (a box mark is a circle around it, to Rust). */
export function rectPath([x, y, w, h]: Rect): [number, number, number][] {
  const corners: Pt[] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x, y],
  ];
  // Points along each side, so the path closes like a hand-drawn loop would.
  return corners
    .slice(0, -1)
    .flatMap(([x0, y0], i) => {
      const [x1, y1] = corners[i + 1] ?? [x0, y0];
      return Array.from({ length: 8 }, (_, k) => {
        const t = k / 8;
        return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 0.5] as [number, number, number];
      });
    })
    .concat([[x, y, 0.5]]);
}
