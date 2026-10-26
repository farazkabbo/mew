import type { BBox, BoardAction } from "@mew/shared";

import { inflateBBox, unionBBox } from "../geometry";
import type { ActionRenderer, BoardPlanner, PlannedAction, RendererMap } from "./board";
import { signed } from "./random";
import { type Box, hbox } from "./typeset/box";
import { drawGeometry, drawMolecule } from "./visuals/figures";
import { drawGraph } from "./visuals/graph";
import { drawPlot } from "./visuals/plot";
import { drawShapes } from "./visuals/shapes";

type Of<T extends BoardAction["type"]> = Extract<BoardAction, { type: T }>;

/** Writes a typeset box at the spot the anchor resolves to. */
function write(
  planner: BoardPlanner,
  box: Box,
  action: { type: BoardAction["type"]; anchor: Of<"write_text">["anchor"] },
  index: number,
  color = planner.input.colors.ink,
): PlannedAction | string {
  if (box.marks.length === 0) return "nothing drawable";
  const rect = planner.place(box, action.anchor);
  const planned = planner.commit(
    { color, pieces: [{ box, at: planner.origin(box, rect) }] },
    action.type,
    index,
  );
  return planned ?? "too much ink";
}

export const writeText: ActionRenderer<Of<"write_text">> = (action, planner, index) =>
  write(planner, planner.typesetText(action.text), action, index);

export const writeMath: ActionRenderer<Of<"write_math">> = (action, planner, index) =>
  write(planner, planner.typesetMath(action.latex), action, index);

export const completeStep: ActionRenderer<Of<"complete_step">> = (action, planner, index) => {
  const parts: Box[] = [];
  if (action.text) parts.push(planner.typesetText(action.text));
  if (action.latex) parts.push(planner.typesetMath(action.latex));
  if (parts.length === 0) return "empty step";
  const box = parts.length === 1 && parts[0] ? parts[0] : hbox(parts, 0.8);
  return write(planner, box, action, index);
};

export const markError: ActionRenderer<Of<"mark_error">> = (action, planner, index) => {
  const { error } = planner.input.colors;
  const line = planner.line(action.targetLineId);
  const note = planner.typesetText(action.note, 0.85);
  if (!line) {
    // The line is gone (or the id was wrong): still give the hint, next to the current work.
    return write(
      planner,
      note,
      { type: action.type, anchor: { near: "margin_right" } },
      index,
      error,
    );
  }
  const circle = planner.commitPaths(
    [ellipseAround(line.bbox, planner)],
    error,
    action.type,
    index,
  );
  if (!circle) return "too much ink";
  if (note.marks.length === 0) return circle;
  const rect = planner.place(note, { near: "margin_right" }, line);
  const written = planner.commit(
    { color: error, pieces: [{ box: note, at: planner.origin(note, rect) }] },
    action.type,
    index,
  );
  return written ? merge(circle, written) : circle;
};

export const markCorrect: ActionRenderer<Of<"mark_correct">> = (action, planner, index) => {
  const line = planner.line(action.targetLineId);
  if (!line) return "unknown line";
  const x = planner.scale.xHeight;
  const size = Math.min(2.5 * x, Math.max(1.2 * x, 0.7 * line.bbox[3]));
  const box: Box = { width: size / x, ascent: size / x, descent: 0, marks: [] };
  const [left, top] = planner.place(box, { near: "active_line" }, line);
  const tick: [number, number][] = [
    [left, top + 0.55 * size],
    [left + 0.35 * size, top + size],
    [left + size, top],
  ];
  return (
    planner.commitPaths([tick], planner.input.colors.correct, action.type, index) ?? "too much ink"
  );
};

/** K6 §6.3: a wavy line under one of the student's lines. */
export const underlineLine: ActionRenderer<Of<"underline">> = (action, planner, index) => {
  const line = planner.line(action.targetLineId);
  if (!line) return "unknown line";
  const [x, y, w, h] = line.bbox;
  const rng = seeded(line.bbox);
  const base = y + h + 0.35 * planner.scale.xHeight;
  const steps = Math.max(8, Math.min(48, Math.round(w / 6)));
  const amplitude = 0.08 * planner.scale.xHeight;
  const path: [number, number][] = Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return [x + t * w, base + amplitude * Math.sin(signed(rng) + t * 9)];
  });
  return planner.commitPaths([path], planner.input.colors.ink, action.type, index) ?? "too much ink";
};

/** K6 §6.3: a loop round one of the student's lines. */
export const circleLine: ActionRenderer<Of<"circle_region">> = (action, planner, index) => {
  const line = planner.line(action.targetLineId);
  if (!line) return "unknown line";
  return (
    planner.commitPaths([ellipseAround(line.bbox, planner)], planner.input.colors.ink, action.type, index) ??
    "too much ink"
  );
};

/** K6 §6.3: an arrow to one of the student's lines from a short note in the margin. */
export const pointAtLine: ActionRenderer<Of<"point_at">> = (action, planner, index) => {
  const line = planner.line(action.targetLineId);
  if (!line) return "unknown line";
  const x = planner.scale.xHeight;
  const note = action.note ? planner.typesetText(action.note, 0.85) : null;
  const box: Box = note ?? { width: 2, ascent: 1, descent: 0, marks: [] };
  const rect = planner.place(box, { near: "margin_right" }, line);
  const [lx, ly, lw, lh] = line.bbox;
  // From the note's left edge to just right of the line, level with its middle.
  const from: [number, number] = [rect[0] - 0.3 * x, rect[1] + rect[3] / 2];
  const to: [number, number] = [lx + lw + 0.4 * x, ly + lh / 2];
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const head = 0.8 * x;
  const wing = (side: number): [number, number] => [
    to[0] - head * Math.cos(angle + side * 0.45),
    to[1] - head * Math.sin(angle + side * 0.45),
  ];
  const paths = [[from, to], [wing(1), to, wing(-1)]];
  const pieces = note ? [{ box: note, at: planner.origin(note, rect) }] : [];
  return (
    planner.commit({ color: planner.input.colors.ink, pieces, paths }, action.type, index) ??
    "too much ink"
  );
};

/** A hand-drawn loop around a line: slightly uneven, overlapping where it closes. */
function ellipseAround(bbox: BBox, planner: BoardPlanner): [number, number][] {
  const pad = 0.45 * planner.scale.xHeight;
  const [x, y, w, h] = inflateBBox(bbox, pad);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rng = seeded(bbox);
  const phase = signed(rng) * Math.PI;
  const start = -2.3 + signed(rng) * 0.2;
  const sweep = 2 * Math.PI + 0.35;
  const steps = 56;
  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = start + (sweep * i) / steps;
    const wobble = 1 + 0.035 * Math.sin(3 * t + phase);
    // The end overshoots slightly outward, as a quick hand-drawn loop does.
    const drift = 1 + 0.06 * (i / steps);
    points.push([cx + (w / 2) * wobble * drift * Math.cos(t), cy + (h / 2) * wobble * Math.sin(t)]);
  }
  return points;
}

function seeded(bbox: BBox): () => number {
  let s = Math.round(bbox[0] * 31 + bbox[1] * 17) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function merge(a: PlannedAction, b: PlannedAction): PlannedAction {
  return { ...a, strokes: [...a.strokes, ...b.strokes], bbox: unionBBox(a.bbox, b.bbox) };
}

/** Renderers for the text and marking actions (M4). Visuals are added by M6. */
export const TEXT_RENDERERS = {
  write_text: writeText,
  write_math: writeMath,
  complete_step: completeStep,
  mark_error: markError,
  mark_correct: markCorrect,
  underline: underlineLine,
  circle_region: circleLine,
  point_at: pointAtLine,
};

/**
 * Every renderer: text and marks (M4), plots, mind maps, flowcharts and sketches (M6), and
 * geometry and molecules (K5).
 */
export const ALL_RENDERERS: RendererMap = {
  ...TEXT_RENDERERS,
  draw_plot: drawPlot,
  draw_graph: drawGraph,
  draw_shapes: drawShapes,
  draw_geometry: drawGeometry,
  draw_molecule: drawMolecule,
};
