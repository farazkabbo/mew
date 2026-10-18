import type { BoardAction } from "@mew/shared";

import type { ActionRenderer } from "../board";
import type { Box } from "../typeset/box";
import { type Path, RoughPen } from "./rough";

type ShapesAction = Extract<BoardAction, { type: "draw_shapes" }>;

/** The unit box the model positions shapes in, scaled to this many x-heights. */
const AREA = { width: 14, height: 9 };
const LABEL_SCALE = 0.7;

/**
 * Simple sketches (brief: arrows, boxes, circles, lines): shapes are given in a 0–1 box that is
 * scaled into free space and drawn by hand, with optional short labels.
 */
export const drawShapes: ActionRenderer<ShapesAction> = (action, planner, index) => {
  const size = planner.visualSize;
  const k = planner.visualFactor;
  /** Typeset boxes (labels) are measured in the student's x-heights. */
  const unit = planner.scale.xHeight;
  const frame: Box = { width: AREA.width * k, ascent: AREA.height * k, descent: 0, marks: [] };
  const [left, top] = planner.place(frame, action.anchor);
  const w = AREA.width * size;
  const h = AREA.height * size;
  const at = (x: number, y: number): [number, number] => [left + x * w, top + y * h];

  const pen = new RoughPen(planner.seed());
  const paths: Path[] = [];
  const pieces: { box: Box; at: [number, number] }[] = [];
  for (const shape of action.shapes) {
    const [x, y] = at(shape.x, shape.y);
    const sw = shape.w * w;
    const sh = shape.h * h;
    switch (shape.kind) {
      case "box":
        paths.push(...pen.rectangle(x, y, Math.max(sw, size), Math.max(sh, size)));
        break;
      case "circle":
        paths.push(...pen.ellipse(x + sw / 2, y + sh / 2, Math.max(sw, size), Math.max(sh, size)));
        break;
      case "line":
      case "arrow": {
        // Lines run from (x, y) to (x + w, y + h).
        const end: [number, number] = [x + sw, y + sh];
        paths.push(...pen.line(x, y, end[0], end[1]));
        if (shape.kind === "arrow" && (sw !== 0 || sh !== 0)) {
          const angle = Math.atan2(sh, sw);
          const len = 0.8 * size;
          paths.push([
            [end[0] - len * Math.cos(angle - 0.45), end[1] - len * Math.sin(angle - 0.45)],
            end,
            [end[0] - len * Math.cos(angle + 0.45), end[1] - len * Math.sin(angle + 0.45)],
          ]);
        }
        break;
      }
    }
    if (shape.label) {
      const label = planner.typesetText(shape.label, LABEL_SCALE * k);
      const centreX = x + sw / 2;
      const baseY =
        shape.kind === "box" || shape.kind === "circle"
          ? y + sh / 2 + ((label.ascent - label.descent) * unit) / 2
          : y + sh / 2 - 0.4 * size;
      pieces.push({ box: label, at: [centreX - (label.width * unit) / 2, baseY] });
    }
  }
  const planned = planner.commit(
    { color: planner.input.colors.ink, pieces, paths },
    action.type,
    index,
  );
  return planned ?? "too much ink";
};
