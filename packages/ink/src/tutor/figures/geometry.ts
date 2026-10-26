import type { GeometrySpec, TriangleSpec, TriangleVertex } from "@mew/shared";

import type { Path } from "../visuals/rough";
import {
  add,
  arc,
  dashed,
  dot,
  type Figure,
  type FigureFrame,
  type FigureLabel,
  fitInto,
  formatNumber,
  length,
  lerp,
  mul,
  sub,
  unit,
  type Vec,
} from "./figure";
import { type SolvedTriangle, solveTriangle } from "./triangle";

/** Labels are written a little smaller than the tutor's notes. */
const LABEL = 0.8;
/** Room kept round a figure for its labels, in units. */
const MARGIN = 2.4;

/**
 * Builds a geometry figure in `frame` (K5): solved in code, scaled to fit, drawn by hand. A spec
 * that can't exist returns the reason instead (the tutor then explains in words).
 */
export function geometryFigure(spec: GeometrySpec, frame: FigureFrame): Figure | string {
  switch (spec.kind) {
    case "triangle":
      return triangleFigure(spec, frame);
    case "circle":
      return circleFigure(spec, frame);
    case "polygon":
      return polygonFigure(spec.sides, spec.labels ?? [], frame);
    case "angle":
      return angleFigure(spec.degrees, spec.label, frame);
    case "coordinate_points":
      return pointsFigure(spec.points, spec.connect ?? false, frame);
  }
}

// ─── Triangles ──────────────────────────────────────────────────────────────────────────────

const VERTICES = ["A", "B", "C"] as const;
const SIDE_OF = { A: "a", B: "b", C: "c" } as const;

/**
 * Where each vertex goes (layout units, y down). A right triangle stands on its longer leg with
 * the right angle at the bottom left; any other triangle stands on its longest side.
 */
export function triangleLayout(t: SolvedTriangle): Record<TriangleVertex, Vec> {
  const others = (v: TriangleVertex) =>
    VERTICES.filter((u) => u !== v) as [TriangleVertex, TriangleVertex];
  if (t.right) {
    const [p, q] = others(t.right);
    // |R P| is the side opposite Q, |R Q| the side opposite P.
    const rp = t[SIDE_OF[q]];
    const rq = t[SIDE_OF[p]];
    const [base, up, baseLength, upLength] = rp >= rq ? [p, q, rp, rq] : [q, p, rq, rp];
    return { [t.right]: [0, 0], [base]: [baseLength, 0], [up]: [0, -upLength] } as Record<
      TriangleVertex,
      Vec
    >;
  }
  const apex = VERTICES.reduce((m, v) => (t[SIDE_OF[v]] > t[SIDE_OF[m]] ? v : m), "A");
  const [left, right] = others(apex);
  // The side from `left` to the apex is the one opposite `right`.
  const reach = t[SIDE_OF[right]];
  const angle = (t[left] * Math.PI) / 180;
  return {
    [left]: [0, 0],
    [right]: [t[SIDE_OF[apex]], 0],
    [apex]: [reach * Math.cos(angle), -reach * Math.sin(angle)],
  } as Record<TriangleVertex, Vec>;
}

function triangleFigure(spec: TriangleSpec, frame: FigureFrame): Figure | string {
  const solved = solveTriangle(spec);
  if (typeof solved === "string") return solved;
  const layout = triangleLayout(solved);
  const u = frame.unit;
  const { map } = fitInto(Object.values(layout), frame.rect, MARGIN * u);
  const at = {
    A: map(layout.A),
    B: map(layout.B),
    C: map(layout.C),
  } satisfies Record<TriangleVertex, Vec>;
  const centroid = mul(add(add(at.A, at.B), at.C), 1 / 3);
  const show = new Set(spec.show ?? ["right_angle_marker", "side_labels"]);
  const highlight = new Set(spec.highlight ?? []);
  const labels: FigureLabel[] = [];
  const paths: Path[] = [];
  const accents: Path[] = [];
  const { pen } = frame;

  // The three sides, one pen stroke each (side a runs between B and C, and so on).
  const ends = (v: TriangleVertex): [Vec, Vec] => {
    const [p, q] = VERTICES.filter((w) => w !== v) as [TriangleVertex, TriangleVertex];
    return [at[p], at[q]];
  };
  for (const v of VERTICES) {
    const [p, q] = ends(v);
    paths.push(...pen.line(p[0], p[1], q[0], q[1]));
    if (highlight.has(SIDE_OF[v])) accents.push([p, q]);
  }

  // Vertex names, outside each corner.
  for (const v of VERTICES) {
    const out = unit(sub(at[v], centroid));
    const text = spec.labels?.[v] ?? v;
    const clear = Math.abs(out[0]) * halfWidth(text, u) + Math.abs(out[1]) * 0.5 * u;
    labels.push({
      text,
      at: add(at[v], mul(out, 0.7 * u + clear)),
      scale: LABEL,
      accent: highlight.has(v),
    });
  }

  // Side names or lengths, outside each side's middle.
  for (const v of VERTICES) {
    const side = SIDE_OF[v];
    const named = spec.labels?.[side];
    const known = spec.given[side];
    if (!named && !(show.has("side_labels") && (known !== undefined || spec.show))) continue;
    const [p, q] = ends(v);
    const middle = lerp(p, q, 0.5);
    // Out from the side, square to it, far enough that the words clear the line.
    const along = unit(sub(q, p));
    let out: Vec = [-along[1], along[0]];
    if (out[0] * (middle[0] - centroid[0]) + out[1] * (middle[1] - centroid[1]) < 0) {
      out = mul(out, -1);
    }
    const text = named ?? (known !== undefined ? formatNumber(known) : side);
    const clear = Math.abs(out[0]) * halfWidth(text, u) + Math.abs(out[1]) * 0.5 * u;
    labels.push({
      text,
      at: add(middle, mul(out, 0.6 * u + clear)),
      scale: LABEL,
      accent: highlight.has(side),
    });
  }

  // The right angle: a real small square in the corner, its sides along the two legs.
  const right = solved.right;
  if (right && (spec.rightAngleAt !== undefined || show.has("right_angle_marker"))) {
    const [p, q] = ends(right);
    paths.push(cornerSquare(at[right], p, q, u));
  }

  if (show.has("angle_arcs")) {
    for (const v of VERTICES) {
      if (v === right) continue;
      const [p, q] = ends(v);
      const radius = Math.min(
        1.6 * u,
        0.3 * Math.min(length(sub(p, at[v])), length(sub(q, at[v]))),
      );
      const path = angleArc(at[v], p, q, radius);
      paths.push(path);
      if (highlight.has(v)) accents.push(path);
      const given = spec.given[v];
      if (given !== undefined) {
        const bisector = unit(add(unit(sub(p, at[v])), unit(sub(q, at[v]))));
        labels.push({
          text: `${formatNumber(given)}°`,
          at: add(at[v], mul(bisector, radius + 1.2 * u)),
          scale: LABEL * 0.9,
        });
      }
    }
  } else {
    for (const v of VERTICES) {
      if (v === right || !highlight.has(v)) continue;
      const [p, q] = ends(v);
      accents.push(angleArc(at[v], p, q, 1.4 * u));
    }
  }

  if (show.has("height")) {
    // From the corner opposite the base (the longest side) down to it, meeting it square.
    const apex = VERTICES.reduce((m, v) => (solved[SIDE_OF[v]] > solved[SIDE_OF[m]] ? v : m), "A");
    const [p, q] = ends(apex);
    const along = unit(sub(q, p));
    const foot = add(p, mul(along, dot2(sub(at[apex], p), along)));
    paths.push(...dashed(at[apex], foot, 0.5 * u, pen));
    if (length(sub(at[apex], foot)) > 2 * u) paths.push(cornerSquare(foot, at[apex], q, u * 0.8));
    labels.push({
      text: "h",
      at: add(lerp(at[apex], foot, 0.5), mul(along, 0.9 * u)),
      scale: LABEL,
    });
  }

  return { paths, accents, labels };
}

/** About half a label's written width (handwriting averages ~0.6 x-heights a letter). */
function halfWidth(text: string, u: number): number {
  return 0.3 * text.length * LABEL * u;
}

/** A small square in the corner at `corner`, its sides along the lines to `p` and `q`. */
function cornerSquare(corner: Vec, p: Vec, q: Vec, u: number): Path {
  const toP = sub(p, corner);
  const toQ = sub(q, corner);
  const size = Math.min(0.9 * u, 0.25 * Math.min(length(toP), length(toQ)));
  const a = add(corner, mul(unit(toP), size));
  const b = add(corner, mul(unit(toQ), size));
  return [a, add(a, sub(b, corner)), b];
}

/** The arc inside the angle at `corner` between the lines to `p` and `q`. */
function angleArc(corner: Vec, p: Vec, q: Vec, radius: number): Path {
  const from = Math.atan2(p[1] - corner[1], p[0] - corner[0]);
  const to = Math.atan2(q[1] - corner[1], q[0] - corner[0]);
  let sweep = to - from;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  return arc(corner, radius, from, sweep, 12);
}

function dot2(p: Vec, q: Vec): number {
  return p[0] * q[0] + p[1] * q[1];
}

// ─── Circles, polygons, angles, points ──────────────────────────────────────────────────────

function circleFigure(spec: Extract<GeometrySpec, { kind: "circle" }>, frame: FigureFrame): Figure {
  const u = frame.unit;
  const [x, y, w, h] = frame.rect;
  const show = new Set(spec.show ?? ["radius"]);
  const labels: FigureLabel[] = [];
  const paths: Path[] = [];
  const { pen } = frame;
  const r = Math.max(u, Math.min(w, h) / 2 - MARGIN * u);
  const centre: Vec = [x + w / 2, y + h / 2];
  const on = (angle: number): Vec => [
    centre[0] + r * Math.cos(angle),
    centre[1] + r * Math.sin(angle),
  ];

  paths.push(...pen.ellipse(centre[0], centre[1], 2 * r, 2 * r));
  paths.push(dot(centre, 0.18 * u));
  labels.push({
    text: spec.labels?.centre ?? "O",
    at: add(centre, [-0.9 * u, 0.9 * u]),
    scale: LABEL,
  });

  if (show.has("radius")) {
    const end = on(-Math.PI / 6);
    paths.push(...pen.line(centre[0], centre[1], end[0], end[1]));
    labels.push({
      text: spec.labels?.radius ?? "r",
      at: add(lerp(centre, end, 0.5), [0, -0.9 * u]),
      scale: LABEL,
    });
  }
  if (show.has("diameter")) {
    const a = on(Math.PI);
    const b = on(0);
    paths.push(...pen.line(a[0], a[1], b[0], b[1]));
    labels.push({
      text: spec.labels?.diameter ?? "d",
      at: add(lerp(centre, a, 0.5), [0, 0.9 * u]),
      scale: LABEL,
    });
  }
  if (show.has("chord")) {
    const a = on((150 * Math.PI) / 180);
    const b = on((40 * Math.PI) / 180);
    paths.push(...pen.line(a[0], a[1], b[0], b[1]));
    labels.push({
      text: spec.labels?.chord ?? "chord",
      at: add(lerp(a, b, 0.5), [0, 1 * u]),
      scale: LABEL,
    });
  }
  if (show.has("tangent")) {
    // Touching at the top, square to the radius there.
    const touch = on(-Math.PI / 2);
    const half = 0.9 * r;
    paths.push(...pen.line(touch[0] - half, touch[1], touch[0] + half, touch[1]));
    paths.push(...dashed(centre, touch, 0.45 * u, pen));
    paths.push(cornerSquare(touch, centre, [touch[0] + half, touch[1]], u * 0.8));
    labels.push({
      text: spec.labels?.tangent ?? "tangent",
      at: [touch[0] - half * 0.6, touch[1] - 1 * u],
      scale: LABEL,
    });
  }
  return { paths, accents: [], labels };
}

function polygonFigure(sides: number, names: readonly string[], frame: FigureFrame): Figure {
  // A regular polygon standing on a flat side.
  const corners: Vec[] = Array.from({ length: sides }, (_, k) => {
    const angle = Math.PI / 2 + Math.PI / sides + (2 * Math.PI * k) / sides;
    return [Math.cos(angle), Math.sin(angle)] as Vec;
  });
  const u = frame.unit;
  const { map } = fitInto(corners, frame.rect, MARGIN * u);
  const at = corners.map(map);
  const centre = mul(at.reduce<Vec>(add, [0, 0]), 1 / sides);
  const first = at[0] ?? centre;
  const paths = frame.pen.polyline([...at, first]);
  const labels = names.slice(0, sides).map((text, k) => {
    const p = at[k] ?? centre;
    return { text, at: add(p, mul(unit(sub(p, centre)), 1.3 * u)), scale: LABEL };
  });
  return { paths, accents: [], labels };
}

function angleFigure(degrees: number, label: string | undefined, frame: FigureFrame): Figure {
  const theta = (degrees * Math.PI) / 180;
  // Rays from the vertex: one along the bottom, one turned anticlockwise (y down: negative).
  const second: Vec = [Math.cos(-theta), Math.sin(-theta)];
  const u = frame.unit;
  const { map, scale } = fitInto([[0, 0], [1, 0], second, [0, -0.2]], frame.rect, MARGIN * u);
  const vertex = map([0, 0]);
  const a = map([1, 0]);
  const b = map(second);
  const { pen } = frame;
  const radius = Math.min(2 * u, 0.3 * scale);
  const paths: Path[] = [
    ...pen.line(vertex[0], vertex[1], a[0], a[1]),
    ...pen.line(vertex[0], vertex[1], b[0], b[1]),
    arc(vertex, radius, 0, -theta, Math.max(8, Math.round(degrees / 10))),
  ];
  const middle: Vec = [Math.cos(-theta / 2), Math.sin(-theta / 2)];
  return {
    paths,
    accents: [],
    labels: [
      {
        text: label ?? `${formatNumber(degrees)}°`,
        at: add(vertex, mul(middle, radius + 1.4 * u)),
        scale: LABEL,
      },
    ],
  };
}

function pointsFigure(
  points: readonly { label: string; x: number; y: number }[],
  connect: boolean,
  frame: FigureFrame,
): Figure {
  const u = frame.unit;
  // The origin is always in view, so the axes are too; y goes up on paper.
  const layout: Vec[] = points.map((p) => [p.x, -p.y]);
  const span = Math.max(1, ...layout.flatMap((p) => [Math.abs(p[0]), Math.abs(p[1])]));
  const pad = span * 0.15;
  const corners: Vec[] = [
    [Math.min(0, ...layout.map((p) => p[0])) - pad, Math.min(0, ...layout.map((p) => p[1])) - pad],
    [Math.max(0, ...layout.map((p) => p[0])) + pad, Math.max(0, ...layout.map((p) => p[1])) + pad],
  ];
  const { map } = fitInto(corners, frame.rect, MARGIN * u);
  const [lo, hi] = corners as [Vec, Vec];
  const { pen } = frame;
  const paths: Path[] = [];
  const xAxis: [Vec, Vec] = [map([lo[0], 0]), map([hi[0], 0])];
  const yAxis: [Vec, Vec] = [map([0, hi[1]]), map([0, lo[1]])];
  for (const [from, to] of [xAxis, yAxis]) {
    paths.push(...pen.line(from[0], from[1], to[0], to[1]));
    const back = mul(unit(sub(from, to)), 0.7 * u);
    const side: Vec = [-back[1] * 0.6, back[0] * 0.6];
    paths.push([add(add(to, back), side), to, sub(add(to, back), side)]);
  }
  const labels: FigureLabel[] = [
    { text: "x", at: add(xAxis[1], [0, 1 * u]), scale: LABEL * 0.9 },
    { text: "y", at: add(yAxis[1], [1 * u, 0]), scale: LABEL * 0.9 },
  ];
  const at = layout.map(map);
  if (connect && at.length >= 2) {
    const first = at[0];
    paths.push(...pen.polyline(at.length >= 3 && first ? [...at, first] : at));
  }
  points.forEach((p, k) => {
    const spot = at[k];
    if (!spot) return;
    paths.push(dot(spot, 0.2 * u));
    const text = `${p.label}(${formatNumber(p.x)}, ${formatNumber(p.y)})`;
    labels.push({
      text: text.length <= 24 ? text : p.label,
      at: add(spot, [0, -1 * u]),
      scale: LABEL * 0.9,
    });
  });
  return { paths, accents: [], labels };
}
