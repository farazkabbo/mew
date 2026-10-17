import type { Stroke } from "@mew/shared";
import { strokePath } from "@mew/ink";

import { displayColor } from "../palette";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Outline paths are expensive to build and strokes are immutable, so cache per stroke object. */
const pathCache = new WeakMap<Stroke, Path2D>();

function pathFor(stroke: Stroke): Path2D {
  let path = pathCache.get(stroke);
  if (!path) {
    path = new Path2D(strokePath(stroke));
    pathCache.set(stroke, path);
  }
  return path;
}

/** Fills strokes in page coordinates; the caller sets the page→pixel transform on `ctx`. */
export function paintStrokes(ctx: Ctx, strokes: Iterable<Stroke>, dark: boolean): void {
  for (const stroke of strokes) {
    ctx.fillStyle = displayColor(stroke.color, dark);
    ctx.fill(pathFor(stroke));
  }
}

/** Paints a stroke that is still being drawn (not cached: its points change every frame). */
export function paintDraft(ctx: Ctx, stroke: Stroke, dark: boolean): void {
  ctx.fillStyle = displayColor(stroke.color, dark);
  ctx.fill(new Path2D(strokePath(stroke, false)));
}
