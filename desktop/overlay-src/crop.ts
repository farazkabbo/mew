/**
 * The clip preview's crop box (S3 §3.2): dragging its edges and corners, moving it, or drawing a
 * new one. Pure; everything is in the capture's pixels ("frame pixels").
 */
export type Rect = [x: number, y: number, w: number, h: number];
export type Size = [w: number, h: number];

/** What a drag holds: an edge or corner, the whole box, or a new box being drawn. */
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move" | "new";

/** The smallest crop the student can make (the server refuses tiny images anyway). */
export const MIN_SIZE = 24;

/** Which handle is under `point`, `tolerance` pixels around the box's edges. */
export function handleAt(crop: Rect, [px, py]: [number, number], tolerance: number): Handle {
  const [x, y, w, h] = crop;
  const near = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  const inX = px >= x - tolerance && px <= x + w + tolerance;
  const inY = py >= y - tolerance && py <= y + h + tolerance;
  if (!inX || !inY) return "new";
  const n = near(py, y);
  const s = near(py, y + h);
  const west = near(px, x);
  const east = near(px, x + w);
  if (n && west) return "nw";
  if (n && east) return "ne";
  if (s && west) return "sw";
  if (s && east) return "se";
  if (n) return "n";
  if (s) return "s";
  if (west) return "w";
  if (east) return "e";
  return "move";
}

/** The crop after dragging `handle` by (dx, dy) from `start`, kept inside the frame. */
export function dragCrop(
  start: Rect,
  handle: Exclude<Handle, "new">,
  dx: number,
  dy: number,
  [fw, fh]: Size,
): Rect {
  const [, , w, h] = start;
  let [left, top] = start;
  let right = left + w;
  let bottom = top + h;
  if (handle === "move") {
    const nx = clamp(left + dx, 0, fw - w);
    const ny = clamp(top + dy, 0, fh - h);
    return [nx, ny, w, h];
  }
  if (handle.includes("w")) left = clamp(left + dx, 0, right - MIN_SIZE);
  if (handle.includes("e")) right = clamp(right + dx, left + MIN_SIZE, fw);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - MIN_SIZE);
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + MIN_SIZE, fh);
  return [left, top, right - left, bottom - top];
}

/** A new crop drawn from `a` to `b` (any direction), inside the frame; null while too small. */
export function cropBetween(a: [number, number], b: [number, number], [fw, fh]: Size): Rect | null {
  const x0 = clamp(Math.min(a[0], b[0]), 0, fw);
  const y0 = clamp(Math.min(a[1], b[1]), 0, fh);
  const x1 = clamp(Math.max(a[0], b[0]), 0, fw);
  const y1 = clamp(Math.max(a[1], b[1]), 0, fh);
  return x1 - x0 >= MIN_SIZE && y1 - y0 >= MIN_SIZE ? [x0, y0, x1 - x0, y1 - y0] : null;
}

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(max, Math.max(min, value));
}
