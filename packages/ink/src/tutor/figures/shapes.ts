import type { Shape } from "@mew/shared";

import type { Path } from "../visuals/rough";
import type { Figure, FigureFrame, FigureLabel } from "./figure";

/**
 * A simple sketch (force diagram, boxes and arrows) in a frame: the shapes' 0–1 coordinates span
 * the frame. The sketch card's version of the notebook's `draw_shapes` (K5).
 */
export function shapesFigure(shapes: readonly Shape[], frame: FigureFrame): Figure {
  const [left, top, w, h] = frame.rect;
  const u = frame.unit;
  const { pen } = frame;
  const paths: Path[] = [];
  const labels: FigureLabel[] = [];
  for (const shape of shapes) {
    const x = left + shape.x * w;
    const y = top + shape.y * h;
    const sw = shape.w * w;
    const sh = shape.h * h;
    switch (shape.kind) {
      case "box":
        paths.push(...pen.rectangle(x, y, Math.max(sw, u), Math.max(sh, u)));
        break;
      case "circle":
        paths.push(...pen.ellipse(x + sw / 2, y + sh / 2, Math.max(sw, u), Math.max(sh, u)));
        break;
      case "line":
      case "arrow": {
        const end: [number, number] = [x + sw, y + sh];
        paths.push(...pen.line(x, y, end[0], end[1]));
        if (shape.kind === "arrow" && (sw !== 0 || sh !== 0)) {
          const angle = Math.atan2(sh, sw);
          const head = 0.9 * u;
          paths.push([
            [end[0] - head * Math.cos(angle - 0.45), end[1] - head * Math.sin(angle - 0.45)],
            end,
            [end[0] - head * Math.cos(angle + 0.45), end[1] - head * Math.sin(angle + 0.45)],
          ]);
        }
        break;
      }
    }
    if (shape.label) {
      const inside = shape.kind === "box" || shape.kind === "circle";
      labels.push({
        text: shape.label,
        at: [x + sw / 2, inside ? y + sh / 2 : y + sh / 2 - 0.9 * u],
        scale: 0.8,
      });
    }
  }
  return { paths, accents: [], labels };
}
