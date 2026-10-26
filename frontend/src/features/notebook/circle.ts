import type { Camera, Line, PageDocument, Vec } from "@mew/ink";

import { studentLines } from "./export-line";

/**
 * The student's lines a loop takes in (K6 §6.3, holding Ctrl+Alt on the page), top to bottom: a
 * line counts when at least half of its strokes are inside, so a loop that clips a neighbour's
 * edge doesn't take that line too.
 */
export function circledLines(doc: PageDocument, loop: readonly Vec[]): Line[] {
  const inside = new Set(doc.inLasso(loop).map((s) => s.id));
  if (inside.size === 0) return [];
  return studentLines(doc)
    .filter((line) => {
      const taken = line.strokeIds.filter((id) => inside.has(id)).length;
      return taken > 0 && taken * 2 >= line.strokeIds.length;
    })
    .sort((a, b) => a.bbox[1] - b.bbox[1]);
}

/** A point on screen (CSS px in the canvas) on the page, under the camera. */
export function toPage([x, y]: Vec, camera: Camera): Vec {
  return [x / camera.zoom + camera.x, y / camera.zoom + camera.y];
}
