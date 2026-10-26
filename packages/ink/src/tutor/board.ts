import type { Anchor, BBox, BoardAction, Point, Stroke, StrokeTool } from "@mew/shared";

import { inflateBBox, unionBBox } from "../geometry";
import { strokeBBox } from "../hit-test";
import type { Line } from "../segmentation";
import { DEFAULT_HANDWRITING, type HandwritingScale, measureHandwriting } from "./handwriting";
import { inkify } from "./inkify";
import { OccupancyGrid, placeBox, searchRegion } from "./placement";
import { seededRandom, seedFrom } from "./random";
import type { Box } from "./typeset/box";
import { typesetLatex } from "./typeset/latex-layout";
import { typesetText } from "./typeset/text";

/** Ink colours for tutor output (light-theme hex; the app remaps them in dark mode). */
export type BoardColors = {
  ink: string;
  error: string;
  correct: string;
  /** The tutor's translucent highlighter (figures' highlighted sides and atoms, K5). */
  highlight?: string;
};

export type BoardInput = {
  pageId: string;
  /** One id per tutor turn: every stroke of the turn shares it (one undo step, one toggle). */
  groupId: string;
  /** Every stroke on the page (student and tutor). */
  strokes: readonly Stroke[];
  /** Lines of the student's handwriting, and the one being worked on. */
  lines: readonly Line[];
  activeLine?: Line | undefined;
  viewport: BBox;
  /** Other things on the page to keep ink off (images clipped from the screen). */
  obstacles?: readonly BBox[];
  colors: BoardColors;
  now: number;
  newId: () => string;
};

/** One action's ink, ready to animate then commit. */
export type PlannedAction = {
  index: number;
  type: BoardAction["type"];
  strokes: Stroke[];
  bbox: BBox;
};

export type SkippedAction = { index: number; type: BoardAction["type"]; reason: string };

export type BoardPlan = {
  actions: PlannedAction[];
  skipped: SkippedAction[];
  scale: HandwritingScale;
  /** Characters the font couldn't draw. */
  missing: string[];
};

/** Lines whose strokes set the writing size. */
const SCALE_FROM_LINES = 3;
/** Widest written text, in x-heights, before wrapping. */
const MAX_TEXT_WIDTH = 26;
/** Clearance kept around student work, in x-heights. */
const CLEARANCE = 0.6;
/** Cap on points per turn, so a pathological response can't flood the page. */
const MAX_POINTS = 30_000;
/** Smallest x-height (page units) plots and diagrams are drawn at. */
const MIN_VISUAL_SIZE = 11;

/** What one action draws: typeset text (wobbled per glyph) and/or free-hand paths in page units. */
export type Drawing = {
  color: string;
  pieces: { box: Box; at: [number, number] }[];
  paths?: [number, number][][];
  /** Highlighter strokes (default: pen) and their width in page units. */
  tool?: StrokeTool;
  width?: number;
};

/** Shared state while planning one turn. */
export class BoardPlanner {
  readonly scale: HandwritingScale;
  readonly grid: OccupancyGrid;
  private readonly rng: () => number;
  private content: BBox | undefined;
  private readonly missing = new Set<string>();
  private createdAt: number;
  private points = 0;

  constructor(readonly input: BoardInput) {
    const studentStrokes = input.strokes.filter((s) => s.author === "student" && s.tool === "pen");
    const recent = [...input.lines]
      .sort((a, b) => b.lastCreatedAt - a.lastCreatedAt)
      .slice(0, SCALE_FROM_LINES)
      .flatMap((l) => l.strokeIds);
    const recentIds = new Set(recent);
    const sample = studentStrokes.filter((s) => recentIds.has(s.id));
    this.scale =
      sample.length > 0
        ? measureHandwriting(sample)
        : studentStrokes.length > 0
          ? measureHandwriting(studentStrokes)
          : DEFAULT_HANDWRITING;

    const obstacles = input.obstacles ?? [];
    this.content = [...input.strokes.map((s) => s.bbox), ...obstacles].reduce<BBox | undefined>(
      (acc, b) => (acc ? unionBBox(acc, b) : b),
      undefined,
    );
    const size = this.scale.xHeight;
    this.grid = new OccupancyGrid(searchRegion(input.viewport, this.content, 60 * size), size / 2);
    for (const stroke of input.strokes) this.grid.mark(inflateBBox(stroke.bbox, CLEARANCE * size));
    for (const box of obstacles) this.grid.mark(inflateBBox(box, CLEARANCE * size));
    this.rng = seededRandom(seedFrom(input.groupId));
    this.createdAt = input.now;
  }

  get gap(): number {
    return this.scale.xHeight;
  }

  line(id?: string): Line | undefined {
    if (id === undefined) return this.input.activeLine;
    return this.input.lines.find((l) => l.id === id);
  }

  typesetText(text: string, scale = 1): Box {
    const layout = typesetText(text, { maxWidth: MAX_TEXT_WIDTH, scale });
    layout.missing.forEach((c) => this.missing.add(c));
    return layout.box;
  }

  typesetMath(latex: string): Box {
    const layout = typesetLatex(latex, { maxWidth: MAX_TEXT_WIDTH });
    layout.missing.forEach((c) => this.missing.add(c));
    return layout.box;
  }

  /** Page rectangle a box of this size occupies once placed for `anchor`. */
  place(box: Box, anchor: Anchor, line = this.input.activeLine): BBox {
    const size = this.scale.xHeight;
    return placeBox([box.width * size, (box.ascent + box.descent) * size], anchor, {
      grid: this.grid,
      line: line?.bbox,
      viewport: this.input.viewport,
      content: this.content,
      gap: this.gap,
    });
  }

  /** Baseline-left page origin for a box placed at `rect`. */
  origin(box: Box, rect: BBox): [number, number] {
    return [rect[0], rect[1] + box.ascent * this.scale.xHeight];
  }

  /**
   * Converts a drawing to strokes and reserves its space for later actions. Paths come first
   * (a box is drawn before its label), then text. Null when the turn's ink budget runs out.
   */
  commit(drawing: Drawing, type: BoardAction["type"], index: number): PlannedAction | null {
    const size = this.scale.xHeight;
    const runs: Point[][] = [];
    if (drawing.paths?.length) {
      // Free-hand paths are already hand-drawn: no extra glyph wobble.
      const box: Box = {
        width: 0,
        ascent: 0,
        descent: 0,
        marks: [
          {
            strokes: drawing.paths.map((p) => p.flatMap(([x, y]) => [x / size, y / size])),
            pivot: [0, 0],
          },
        ],
      };
      runs.push(...inkify(box, [0, 0], { xHeight: size, rng: this.rng, jitter: 0 }));
    }
    for (const piece of drawing.pieces) {
      runs.push(...inkify(piece.box, piece.at, { xHeight: size, rng: this.rng }));
    }
    this.points += runs.reduce((n, points) => n + points.length, 0);
    if (this.points > MAX_POINTS) return null;
    return this.reserve(
      runs.map((points) => this.stroke(points, drawing.color, drawing.tool, drawing.width)),
      type,
      index,
    );
  }

  /** Free-hand strokes (circles, ticks) already in page coordinates. */
  commitPaths(
    paths: [number, number][][],
    color: string,
    type: BoardAction["type"],
    index: number,
  ): PlannedAction | null {
    return this.commit({ color, pieces: [], paths }, type, index);
  }

  /** A fresh seed for hand-drawn shapes, derived from the turn (reproducible). */
  seed(): number {
    return Math.floor(this.rng() * 2 ** 31);
  }

  /** The visible page area (for sizing big visuals). */
  get viewport(): BBox {
    return this.input.viewport;
  }

  /**
   * Size unit for plots and diagrams: the student's x-height, but never so small that a graph is
   * cramped (small handwriting, or an empty page at the default size).
   */
  get visualSize(): number {
    return Math.max(this.scale.xHeight, this.input.viewport[2] / 90, MIN_VISUAL_SIZE);
  }

  /** How much larger visuals are drawn than the student's writing (≥ 1). */
  get visualFactor(): number {
    return this.visualSize / this.scale.xHeight;
  }

  missingCharacters(): string[] {
    return [...this.missing];
  }

  private reserve(
    strokes: Stroke[],
    type: BoardAction["type"],
    index: number,
  ): PlannedAction | null {
    const first = strokes[0];
    if (!first) return null;
    const bbox = strokes.map((s) => s.bbox).reduce(unionBBox, first.bbox);
    this.grid.mark(inflateBBox(bbox, CLEARANCE * this.scale.xHeight));
    this.content = this.content ? unionBBox(this.content, bbox) : bbox;
    return { index, type, strokes, bbox };
  }

  private stroke(
    points: Point[],
    color: string,
    tool: StrokeTool = "pen",
    width = this.scale.penWidth,
  ): Stroke {
    return {
      id: this.input.newId(),
      pageId: this.input.pageId,
      author: "tutor",
      tool,
      points,
      color,
      width,
      bbox: strokeBBox(points, width),
      createdAt: this.createdAt++,
      groupId: this.input.groupId,
    };
  }
}

/**
 * Draws one kind of action; returns a reason string when it can't. May be async (graph layout
 * runs asynchronously); actions are still planned one after another, in order.
 */
export type ActionRenderer<T extends BoardAction = BoardAction> = (
  action: T,
  planner: BoardPlanner,
  index: number,
) => PlannedAction | string | Promise<PlannedAction | string>;

export type RendererMap = {
  [K in BoardAction["type"]]?: ActionRenderer<Extract<BoardAction, { type: K }>>;
};

/**
 * Plans a turn's board actions as tutor ink: each action is laid out at the student's writing
 * size and placed in free space so it never covers their work. Actions without a renderer
 * (or that fail) are reported in `skipped`.
 */
export async function planBoard(
  actions: readonly BoardAction[],
  input: BoardInput,
  renderers: RendererMap,
): Promise<BoardPlan> {
  const planner = new BoardPlanner(input);
  const planned: PlannedAction[] = [];
  const skipped: SkippedAction[] = [];
  for (const [index, action] of actions.entries()) {
    const render = renderers[action.type] as ActionRenderer | undefined;
    if (!render) {
      skipped.push({ index, type: action.type, reason: "not supported yet" });
      continue;
    }
    let result: PlannedAction | string;
    try {
      result = await render(action, planner, index);
    } catch {
      result = "failed to draw";
    }
    if (typeof result === "string") skipped.push({ index, type: action.type, reason: result });
    else planned.push(result);
  }
  return {
    actions: planned,
    skipped,
    scale: planner.scale,
    missing: planner.missingCharacters(),
  };
}

/**
 * Moves a planned action that now collides with the page (the student wrote there while the
 * tutor's ink was paused) to the nearest free spot. Returns it unchanged when it still fits.
 */
export function relocateAction(action: PlannedAction, input: BoardInput): PlannedAction {
  const planner = new BoardPlanner(input);
  if (planner.grid.isFree(action.bbox)) return action;
  const [x, y, w, h] = action.bbox;
  const size = planner.scale.xHeight;
  const box: Box = { width: w / size, ascent: h / size, descent: 0, marks: [] };
  const [nx, ny] = planner.place(
    box,
    { near: "free_space" },
    {
      id: "relocate",
      strokeIds: [],
      bbox: action.bbox,
      firstCreatedAt: 0,
      lastCreatedAt: 0,
    },
  );
  const dx = nx - x;
  const dy = ny - y;
  return {
    ...action,
    bbox: [nx, ny, w, h],
    strokes: action.strokes.map((s) => ({
      ...s,
      points: s.points.map(([px, py, p, t]) => [px + dx, py + dy, p, t] as Point),
      bbox: [s.bbox[0] + dx, s.bbox[1] + dy, s.bbox[2], s.bbox[3]],
    })),
  };
}
