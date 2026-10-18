import type { BoardAction } from "@mew/shared";

import type { ActionRenderer } from "../board";
import type { Box } from "../typeset/box";
import { compileExpression, ExprError, type Fn } from "./expr";
import { type Path, RoughPen } from "./rough";

type PlotAction = Extract<BoardAction, { type: "draw_plot" }>;

/** Plot size in x-heights (the axes box), and the room around it for tick labels. */
const WIDTH = 24;
const HEIGHT = 15;
const MARGIN = { left: 2.6, right: 1, top: 0.8, bottom: 2 };
const SAMPLES = 240;
const LABEL_SCALE = 0.55;
const MAX_SPAN = 1e6;

/**
 * Function plots (brief §6.5) drawn as ink: hand-drawn axes with arrowheads, a few ticks with
 * numbers, and each curve sampled and drawn as a pen stroke (broken where the function jumps or
 * leaves the visible range, e.g. tan x).
 */
export const drawPlot: ActionRenderer<PlotAction> = (action, planner, index) => {
  const curves: { fn: Fn; source: string }[] = [];
  for (const source of action.expressions) {
    try {
      curves.push({ fn: compileExpression(source), source });
    } catch (error) {
      if (!(error instanceof ExprError)) throw error;
    }
  }
  if (curves.length === 0) return "couldn't read the expression";

  const [x0, x1] = validRange(action.xRange) ?? [-10, 10];
  const samples = curves.map(({ fn }) =>
    Array.from({ length: SAMPLES + 1 }, (_, i) => {
      const x = x0 + ((x1 - x0) * i) / SAMPLES;
      const y = fn(x);
      return [x, Number.isFinite(y) ? y : NaN] as [number, number];
    }),
  );
  const [y0, y1] = (action.yRange && validRange(action.yRange)) ?? autoRange(samples);

  // Plots use the visual size (at least readable), in page units; frame sizes are given to the
  // planner in the student's x-heights, so they're scaled by k.
  const size = planner.visualSize;
  const k = planner.visualFactor;
  /** Typeset boxes (labels) are measured in the student's x-heights. */
  const unit = planner.scale.xHeight;
  const frame: Box = {
    width: (WIDTH + MARGIN.left + MARGIN.right) * k,
    ascent: (HEIGHT + MARGIN.top + MARGIN.bottom) * k,
    descent: 0,
    marks: [],
  };
  const [left, top] = planner.place(frame, action.anchor);
  const area = {
    left: left + MARGIN.left * size,
    right: left + (MARGIN.left + WIDTH) * size,
    top: top + MARGIN.top * size,
    bottom: top + (MARGIN.top + HEIGHT) * size,
  };
  const px = (x: number) => area.left + ((x - x0) / (x1 - x0)) * (area.right - area.left);
  const py = (y: number) => area.bottom - ((y - y0) / (y1 - y0)) * (area.bottom - area.top);

  const pen = new RoughPen(planner.seed(), 0.6);
  const paths: Path[] = [];
  const pieces: { box: Box; at: [number, number] }[] = [];

  // Axes through the origin when it's in view, else along the edges.
  const axisY = y0 <= 0 && y1 >= 0 ? py(0) : area.bottom;
  const axisX = x0 <= 0 && x1 >= 0 ? px(0) : area.left;
  const overshoot = 0.6 * size;
  paths.push(...pen.line(area.left - overshoot / 2, axisY, area.right + overshoot, axisY));
  paths.push(...pen.line(axisX, area.bottom + overshoot / 2, axisX, area.top - overshoot));
  paths.push(head([area.right + overshoot, axisY], 0, size));
  paths.push(head([axisX, area.top - overshoot], -Math.PI / 2, size));

  const tick = 0.3 * size;
  for (const x of ticks(x0, x1)) {
    if (Math.abs(px(x) - axisX) < 1) continue;
    paths.push([
      [px(x), axisY - tick],
      [px(x), axisY + tick],
    ]);
    const label = planner.typesetText(format(x), LABEL_SCALE * k);
    pieces.push({ box: label, at: [px(x) - (label.width * unit) / 2, axisY + 1.4 * size] });
  }
  for (const y of ticks(y0, y1)) {
    if (Math.abs(py(y) - axisY) < 1) continue;
    paths.push([
      [axisX - tick, py(y)],
      [axisX + tick, py(y)],
    ]);
    const label = planner.typesetText(format(y), LABEL_SCALE * k);
    pieces.push({
      box: label,
      at: [axisX - tick - label.width * unit - 0.3 * size, py(y) + 0.3 * size],
    });
  }
  pieces.push({
    box: planner.typesetText("x", 0.7 * k),
    at: [area.right + overshoot, axisY - 0.5 * size],
  });
  pieces.push({
    box: planner.typesetText("y", 0.7 * k),
    at: [axisX + 0.4 * size, area.top - 0.2 * size],
  });

  // The curves, split where the function breaks or leaves the view.
  const span = y1 - y0;
  samples.forEach((points, i) => {
    let run: Path = [];
    let prev: number | null = null;
    for (const [x, y] of points) {
      const inside = Number.isFinite(y) && y >= y0 - 0.02 * span && y <= y1 + 0.02 * span;
      const jump = prev !== null && Math.abs(y - prev) > 0.6 * span;
      if (!inside || jump) {
        if (run.length > 1) paths.push(run);
        run = [];
      }
      if (inside) run.push([px(x), py(Math.min(y1, Math.max(y0, y)))]);
      prev = Number.isFinite(y) ? y : null;
    }
    if (run.length > 1) paths.push(run);
    // Name each curve near its right end when there are several.
    const last = points.findLast(([, y]) => Number.isFinite(y) && y >= y0 && y <= y1);
    if (curves.length > 1 && last) {
      const label = planner.typesetText(curves[i]?.source ?? "", LABEL_SCALE * k);
      pieces.push({ box: label, at: [px(last[0]) - label.width * unit, py(last[1]) - 0.6 * size] });
    }
  });

  const planned = planner.commit(
    { color: planner.input.colors.ink, pieces, paths },
    action.type,
    index,
  );
  return planned ?? "too much ink";
};

function validRange([a, b]: readonly [number, number]): [number, number] | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b || b - a > MAX_SPAN) return null;
  return [a, b];
}

/** y range from the samples, ignoring the extreme 4% (asymptotes) and padding a little. */
function autoRange(samples: [number, number][][]): [number, number] {
  const ys = samples
    .flat()
    .map(([, y]) => y)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (ys.length === 0) return [-10, 10];
  const lo = ys[Math.floor(ys.length * 0.02)] ?? 0;
  const hi = ys[Math.ceil(ys.length * 0.98) - 1] ?? 0;
  if (hi - lo < 1e-9) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.12;
  return [lo - pad, hi + pad];
}

/** About five "nice" tick values (1, 2 or 5 × 10^k apart) within [a, b]. */
export function ticks(a: number, b: number): number[] {
  const raw = (b - a) / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  // The round step closest (by ratio) to the ideal one.
  const step = [1, 2, 5, 10]
    .map((m) => m * power)
    .reduce((best, s) => (Math.abs(Math.log(s / raw)) < Math.abs(Math.log(best / raw)) ? s : best));
  const out: number[] = [];
  for (let k = Math.ceil(a / step - 1e-9); k * step <= b + 1e-9; k++) {
    // Multiply rather than accumulate, and trim float noise (0.6000000000000001 → 0.6).
    out.push(Number((k * step).toPrecision(12)) || 0);
    if (out.length > 12) break;
  }
  return out;
}

function format(v: number): string {
  return Number(v.toPrecision(4)).toString().replace("-", "−");
}

function head(tip: [number, number], angle: number, size: number): Path {
  const len = 0.6 * size;
  return [
    [tip[0] - len * Math.cos(angle - 0.45), tip[1] - len * Math.sin(angle - 0.45)],
    tip,
    [tip[0] - len * Math.cos(angle + 0.45), tip[1] - len * Math.sin(angle + 0.45)],
  ];
}
