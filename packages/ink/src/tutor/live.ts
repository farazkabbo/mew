import type { BBox, LiveMarkKind, Stroke } from "@mew/shared";

import { inflateBBox, unionBBox } from "../geometry";
import { strokeBBox } from "../hit-test";
import { ellipseAround, seeded } from "./actions";
import { type BoardInput, BoardPlanner, type PlannedAction } from "./board";
import { signed } from "./random";
import type { Box } from "./typeset/box";

/**
 * A live annotation's ink (K9 §7.1): what the tutor writes beside a finished line as the student
 * goes. Small and quiet, and never the corrected line:
 * - tick: a small check at the end of the line;
 * - error: a loop round the wrong part (or the whole line) and a 1–4 word note in the margin;
 * - missing: a wavy underline and its note ("units?", "not balanced");
 * - margin: a note in the margin with a short arrow to the line (writing subjects, Coach);
 * - unsure: a dashed "?" at the end of the line (neb isn't sure what it read).
 * Every stroke carries its `markKind`, so the eraser, the lasso and undo leave it alone.
 */
export type LiveMarkSpec = {
  kind: LiveMarkKind;
  note: string | null;
  lineId: string;
  /** The part of the line to circle or underline (the wrong side of an equation). */
  focus?: BBox | undefined;
};

export type LiveMarkInk = {
  strokes: Stroke[];
  bbox: BBox;
  /** Where a tap opens the mark's menu: its tick, note or "?" (never the loop round the line). */
  hitBox: BBox;
};

const TYPE = "mark_error" as const;

/**
 * Where a mark's words go: written in neb's ink beside the line ("page", K9), or left to the
 * neb lane in the margin ("lane", NEB_APP_UI §4.2: the page keeps only the circle, the underline
 * or a small bracket, and the words are a note card).
 */
export type MarkWords = "page" | "lane";

export function planLiveMarkInk(
  spec: LiveMarkSpec,
  input: BoardInput,
  words: MarkWords = "page",
): LiveMarkInk | null {
  const planner = new BoardPlanner(input);
  const line = planner.line(spec.lineId);
  if (!line) return null;
  const { colors } = input;
  const focus = spec.focus ?? line.bbox;
  const x = planner.scale.xHeight;

  const note = (color: string): PlannedAction | null => {
    if (!spec.note || words === "lane") return null;
    const box = planner.typesetText(spec.note, 0.85);
    if (box.marks.length === 0) return null;
    const rect = planner.place(box, { near: "margin_right" }, line);
    return planner.commit({ color, pieces: [{ box, at: planner.origin(box, rect) }] }, TYPE, 0);
  };
  const done = (parts: (PlannedAction | null)[], hit: PlannedAction | null) => {
    const kept = parts.filter((p): p is PlannedAction => p !== null);
    const first = kept[0];
    if (!first) return null;
    const strokes = kept.flatMap((p) => p.strokes).map((s) => ({ ...s, markKind: spec.kind }));
    return {
      strokes,
      bbox: kept.map((p) => p.bbox).reduce(unionBBox, first.bbox),
      hitBox: inflateBBox((hit ?? first).bbox, 0.4 * x),
    };
  };

  switch (spec.kind) {
    case "tick": {
      const size = Math.min(2.5 * x, Math.max(1.2 * x, 0.7 * line.bbox[3]));
      const box: Box = { width: size / x, ascent: size / x, descent: 0, marks: [] };
      const [left, top] = planner.place(box, { near: "active_line" }, line);
      const tick = planner.commitPaths(
        [
          [
            [left, top + 0.55 * size],
            [left + 0.35 * size, top + size],
            [left + size, top],
          ],
        ],
        colors.correct,
        TYPE,
        0,
      );
      return done([tick], tick);
    }
    case "error": {
      const loop = planner.commitPaths([ellipseAround(focus, planner)], colors.error, TYPE, 0);
      const written = note(colors.error);
      return done([loop, written], written);
    }
    case "missing": {
      const [fx, fy, fw, fh] = focus;
      const rng = seeded(focus);
      const base = fy + fh + 0.35 * x;
      const steps = Math.max(8, Math.min(48, Math.round(fw / 6)));
      const wave: [number, number][] = Array.from({ length: steps + 1 }, (_, i) => {
        const t = i / steps;
        return [fx + t * fw, base + 0.08 * x * Math.sin(signed(rng) + t * 9)];
      });
      const underline = planner.commitPaths([wave], colors.error, TYPE, 0);
      const written = note(colors.error);
      return done([underline, written], written);
    }
    case "margin": {
      if (words === "lane") {
        // The words are a card in the lane: on the page, a small bracket closing the line.
        const [lx, ly, lw, lh] = line.bbox;
        const bx = lx + lw + 0.5 * x;
        const bracket = planner.commitPaths(
          [
            [
              [bx - 0.3 * x, ly],
              [bx, ly],
              [bx, ly + lh],
              [bx - 0.3 * x, ly + lh],
            ],
          ],
          colors.ink,
          TYPE,
          0,
        );
        return done([bracket], bracket);
      }
      const written = note(colors.ink);
      if (!written) return null;
      const [lx, ly, lw, lh] = line.bbox;
      const from: [number, number] = [
        written.bbox[0] - 0.3 * x,
        written.bbox[1] + written.bbox[3] / 2,
      ];
      const to: [number, number] = [lx + lw + 0.4 * x, ly + lh / 2];
      const arrow =
        from[0] - to[0] > 0.8 * x
          ? planner.commitPaths(
              [
                [from, to],
                [[to[0] + 0.6 * x, to[1] - 0.35 * x], to, [to[0] + 0.6 * x, to[1] + 0.35 * x]],
              ],
              colors.ink,
              TYPE,
              0,
            )
          : null;
      return done([written, arrow], written);
    }
    case "unsure": {
      const box = planner.typesetText("?", 1);
      if (box.marks.length === 0) return null;
      const rect = planner.place(box, { near: "active_line" }, line);
      const planned = planner.commit(
        { color: colors.ink, pieces: [{ box, at: planner.origin(box, rect) }] },
        TYPE,
        0,
      );
      if (!planned) return null;
      const dashed = {
        ...planned,
        strokes: planned.strokes.flatMap((s) => dashes(s, 0.45 * x, input.newId)),
      };
      return done([dashed], dashed);
    }
  }
}

/** A stroke cut into dashes about `length` long, with gaps as long (the "?" of §7.1). */
export function dashes(stroke: Stroke, length: number, newId: () => string): Stroke[] {
  const pieces: Stroke[] = [];
  let current: Stroke["points"] = [];
  let run = 0;
  let drawing = true;
  for (const [i, point] of stroke.points.entries()) {
    const previous = stroke.points[i - 1];
    const step = previous ? Math.hypot(point[0] - previous[0], point[1] - previous[1]) : 0;
    run += step;
    if (drawing) current.push(point);
    if (run >= length) {
      if (drawing && current.length > 1) pieces.push(piece(stroke, current, pieces.length, newId));
      current = drawing ? [] : [point];
      drawing = !drawing;
      run = 0;
    }
  }
  if (drawing && current.length > 1) pieces.push(piece(stroke, current, pieces.length, newId));
  return pieces.length > 0 ? pieces : [stroke];
}

function piece(
  stroke: Stroke,
  points: Stroke["points"],
  index: number,
  newId: () => string,
): Stroke {
  return {
    ...stroke,
    id: index === 0 ? stroke.id : newId(),
    points,
    bbox: strokeBBox(points, stroke.width),
  };
}
