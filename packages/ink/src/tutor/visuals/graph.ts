import type { BoardAction } from "@mew/shared";
import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";

import type { ActionRenderer, BoardPlanner } from "../board";
import type { Box } from "../typeset/box";
import { type Path, RoughPen } from "./rough";

type GraphAction = Extract<BoardAction, { type: "draw_graph" }>;

/** ELK works in its own units: this many per x-height. */
const UNIT = 10;
const LABEL_SCALE = 0.85;
const EDGE_LABEL_SCALE = 0.6;
/** Widest a diagram may be, as a share of the visible page; labels shrink to fit. */
const MAX_WIDTH_SHARE = 0.9;
const MIN_FIT = 0.55;

let elk: InstanceType<typeof ELK> | null = null;

type Laid = {
  width: number;
  height: number;
  nodes: { id: string; x: number; y: number; w: number; h: number; label: Box; root: boolean }[];
  edges: { from: string; to: string; points: [number, number][] | null; label: Box | null }[];
};

/**
 * Mind maps and flowcharts (brief §6.5): ELK lays the graph out (radial around the central idea
 * for a mind map, layered top-down for a flowchart), roughjs draws the boxes, ellipses and
 * arrows as wobbly pen paths, and the labels are written in the tutor's hand.
 */
export const drawGraph: ActionRenderer<GraphAction> = async (action, planner, index) => {
  const laid = await layout(action, planner);
  if (!laid) return "nothing to draw";
  const size = planner.scale.xHeight;

  // Fit the page: shrink a big diagram (down to a limit) rather than run off screen.
  const maxWidth = (planner.viewport[2] * MAX_WIDTH_SHARE) / size;
  const fit = Math.max(MIN_FIT, Math.min(1, maxWidth / laid.width));
  const frame: Box = { width: laid.width * fit, ascent: laid.height * fit, descent: 0, marks: [] };
  const [left, top] = planner.place(frame, action.anchor);
  const at = (x: number, y: number): [number, number] => [
    left + x * fit * size,
    top + y * fit * size,
  ];

  const pen = new RoughPen(planner.seed());
  const paths: Path[] = [];
  const pieces: { box: Box; at: [number, number] }[] = [];
  const centre = new Map<string, Laid["nodes"][number]>();

  for (const node of laid.nodes) {
    centre.set(node.id, node);
    const [x, y] = at(node.x, node.y);
    const w = node.w * fit * size;
    const h = node.h * fit * size;
    if (action.kind === "mindmap") paths.push(...pen.ellipse(x + w / 2, y + h / 2, w, h));
    else paths.push(...pen.rectangle(x, y, w, h));
    const label = scaleBox(node.label, fit);
    const lx = x + (w - label.width * size) / 2;
    const ly = y + h / 2 + ((label.ascent - label.descent) * size) / 2;
    pieces.push({ box: label, at: [lx, ly] });
  }

  for (const edge of laid.edges) {
    const a = centre.get(edge.from);
    const b = centre.get(edge.to);
    if (!a || !b) continue;
    const route =
      edge.points && action.kind === "flowchart"
        ? edge.points.map(([x, y]) => at(x, y))
        : [border(a, b, action.kind, at, fit, size), border(b, a, action.kind, at, fit, size)];
    if (route.length < 2) continue;
    paths.push(...pen.polyline(route));
    if (action.kind === "flowchart")
      paths.push(arrowHead(route, size * fit * planner.visualFactor));
    if (edge.label) {
      const mid = route[Math.floor(route.length / 2)] ?? route[0] ?? [0, 0];
      const prev = route[Math.floor(route.length / 2) - 1] ?? mid;
      const [mx, my] = [(mid[0] + prev[0]) / 2, (mid[1] + prev[1]) / 2];
      const label = scaleBox(edge.label, fit);
      pieces.push({ box: label, at: [mx + 0.3 * size, my - 0.2 * size] });
    }
  }

  const planned = planner.commit(
    { color: planner.input.colors.ink, pieces, paths },
    action.type,
    index,
  );
  return planned ?? "too much ink";
};

async function layout(action: GraphAction, planner: BoardPlanner): Promise<Laid | null> {
  // Diagrams are drawn at the visual size: labels, padding and spacing grow by this factor.
  const k = planner.visualFactor;
  // Unique nodes with non-empty labels; edges only between them.
  const nodes = new Map<string, { id: string; label: Box }>();
  for (const node of action.nodes) {
    if (nodes.has(node.id)) continue;
    const label = planner.typesetText(node.label, LABEL_SCALE * k);
    if (label.marks.length > 0) nodes.set(node.id, { id: node.id, label });
  }
  if (nodes.size === 0) return null;
  const edges = action.edges.filter((e) => nodes.has(e.from) && nodes.has(e.to) && e.from !== e.to);
  const root = action.kind === "mindmap" ? mindMapRoot([...nodes.keys()], edges) : null;

  const pad = { x: 1.2 * k, y: 0.9 * k };
  const sized = [...nodes.values()].map((n) => {
    const big = n.id === root;
    const w = n.label.width + 2 * pad.x * (big ? 1.4 : 1);
    const h = n.label.ascent + n.label.descent + 2 * pad.y * (big ? 1.3 : 1);
    return { ...n, w, h };
  });
  // The root first: ELK's radial layout centres the first node.
  sized.sort((a, b) => (a.id === root ? -1 : b.id === root ? 1 : 0));

  const graph: ElkNode = {
    id: "graph",
    layoutOptions:
      action.kind === "mindmap"
        ? {
            "elk.algorithm": "radial",
            // A small minimum radius plus wedge compaction keeps the map close around its centre.
            "elk.radial.radius": String(2 * UNIT * k),
            "elk.radial.compactor": "WEDGE_COMPACTION",
            "elk.spacing.nodeNode": String(1.5 * UNIT * k),
          }
        : {
            "elk.algorithm": "layered",
            "elk.direction": "DOWN",
            "elk.edgeRouting": "POLYLINE",
            "elk.spacing.nodeNode": String(2.5 * UNIT * k),
            "elk.layered.spacing.nodeNodeBetweenLayers": String(3 * UNIT * k),
          },
    children: sized.map((n) => ({ id: n.id, width: n.w * UNIT, height: n.h * UNIT })),
    edges: edges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  };
  elk ??= new ELK();
  const result = await elk.layout(graph);

  const byId = new Map(sized.map((n) => [n.id, n]));
  const laidNodes = (result.children ?? []).flatMap((child) => {
    const n = byId.get(child.id);
    if (!n) return [];
    return [
      {
        id: n.id,
        x: (child.x ?? 0) / UNIT,
        y: (child.y ?? 0) / UNIT,
        w: n.w,
        h: n.h,
        label: n.label,
        root: n.id === root,
      },
    ];
  });
  const laidEdges = edges.map((e, i) => {
    const section = result.edges?.find((r) => r.id === `e${i}`)?.sections?.[0];
    const points: [number, number][] | null = section
      ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((p) => [
          p.x / UNIT,
          p.y / UNIT,
        ])
      : null;
    const label = e.label ? planner.typesetText(e.label, EDGE_LABEL_SCALE * k) : null;
    return { from: e.from, to: e.to, points, label: label?.marks.length ? label : null };
  });
  return {
    width: (result.width ?? 0) / UNIT,
    height: (result.height ?? 0) / UNIT,
    nodes: laidNodes,
    edges: laidEdges,
  };
}

/** The central idea: the node with the most connections (the first one on a tie). */
function mindMapRoot(ids: string[], edges: { from: string; to: string }[]): string | null {
  let best: string | null = null;
  let most = -1;
  for (const id of ids) {
    const degree = edges.filter((e) => e.from === id || e.to === id).length;
    if (degree > most) {
      best = id;
      most = degree;
    }
  }
  return best;
}

/** Where the line from `a`'s centre towards `b`'s centre leaves `a`'s outline. */
function border(
  a: Laid["nodes"][number],
  b: Laid["nodes"][number],
  kind: GraphAction["kind"],
  at: (x: number, y: number) => [number, number],
  fit: number,
  size: number,
): [number, number] {
  const [ax, ay] = at(a.x + a.w / 2, a.y + a.h / 2);
  const [bx, by] = at(b.x + b.w / 2, b.y + b.h / 2);
  const dx = bx - ax;
  const dy = by - ay;
  const rx = (a.w * fit * size) / 2;
  const ry = (a.h * fit * size) / 2;
  if (dx === 0 && dy === 0) return [ax, ay];
  const t =
    kind === "mindmap"
      ? 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry))
      : Math.min(dx === 0 ? Infinity : rx / Math.abs(dx), dy === 0 ? Infinity : ry / Math.abs(dy));
  return [ax + dx * t, ay + dy * t];
}

function arrowHead(route: [number, number][], scale: number): Path {
  const tip = route.at(-1) ?? [0, 0];
  const from = route.at(-2) ?? tip;
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const len = 0.8 * scale;
  const spread = 0.45;
  return [
    [tip[0] - len * Math.cos(angle - spread), tip[1] - len * Math.sin(angle - spread)],
    tip,
    [tip[0] - len * Math.cos(angle + spread), tip[1] - len * Math.sin(angle + spread)],
  ];
}

function scaleBox(box: Box, s: number): Box {
  if (s === 1) return box;
  return {
    width: box.width * s,
    ascent: box.ascent * s,
    descent: box.descent * s,
    marks: box.marks.map((m) => ({
      strokes: m.strokes.map((st) => st.map((v) => v * s)),
      pivot: [m.pivot[0] * s, m.pivot[1] * s],
    })),
  };
}
