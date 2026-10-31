import type {
  BBox,
  FocusKind,
  NoteSide,
  Point,
  ScreenAction,
  ScreenBox,
  ScreenPoint,
  SketchFigure,
  StrokeTool,
} from "@mew/shared";

import { inflateBBox, unionBBox } from "../../geometry";
import { strokeBBox } from "../../hit-test";
import type { Figure } from "../figures/figure";
import { geometryFigure } from "../figures/geometry";
import { cachedMolecule, loadMolecule, moleculeFigure } from "../figures/molecule";
import { shapesFigure } from "../figures/shapes";
import { inkify } from "../inkify";
import { OccupancyGrid, overlapsAny } from "../placement";
import { seededRandom, seedFrom, signed } from "../random";
import type { Box } from "../typeset/box";
import { typesetLatex } from "../typeset/latex-layout";
import { typesetText } from "../typeset/text";
import { RoughPen } from "../visuals/rough";
import { snapLine, snapPoint, snapRegion } from "./snap";

/**
 * Plans Screen Coach's ink on the student's screen (docs/SCREEN_COACH_S3.md §2): the same
 * handwriting and shapes as the notebook, placed *beside* what's on screen rather than on it.
 *
 * Everything is in overlay pixels: physical screen pixels from the top-left of the monitor the
 * overlay covers. The desktop app maps the capture there and passes the on-screen text as
 * rectangles only (never the words), so placement can keep clear of it.
 */

/** One stroke of screen ink, ready to animate (and, if the student saves, to clip). */
export type ScreenStroke = {
  tool: StrokeTool;
  color: string;
  width: number;
  points: Point[];
  bbox: BBox;
};

export type ScreenInkColors = {
  ink: string;
  /** The highlighter's translucent tutor colour. */
  highlight: string;
  /** Notes Check's amber: "look at this again" (a circle with tone "question"). */
  question?: string | undefined;
};

export type ScreenInkInput = {
  /** The captured area: normalised 0–1000 coordinates span this rectangle. */
  frame: BBox;
  /** Where ink may go at all (the monitor). */
  bounds: BBox;
  /** On-screen text and other content to keep notes off. */
  obstacles: readonly BBox[];
  /**
   * The on-screen words (OCR boxes): circles, underlines, highlights and arrows aimed at text
   * snap onto them (`snap.ts`). Leave out to draw exactly where the actions say.
   */
  words?: readonly BBox[] | undefined;
  /** Typical height of the text on screen (OCR word height); undefined when unknown. */
  textHeight?: number | undefined;
  /** Physical pixels per CSS pixel (monitor DPI / 96). */
  scale: number;
  /** Seeds the hand-drawn wobble (one turn always draws the same). */
  seed: string;
  colors: ScreenInkColors;
};

export type PlannedScreenAction = {
  index: number;
  type: ScreenAction["type"];
  strokes: ScreenStroke[];
  /** A sticky note's paper, drawn under its strokes, when there was no free space. */
  card?: BBox;
  /** The spot an arrow means, snapped onto the control (where neb's pointer flies). */
  target?: [number, number];
  bbox: BBox;
};

export type ScreenInkPlan = {
  actions: PlannedScreenAction[];
  skipped: { index: number; type: ScreenAction["type"]; reason: string }[];
  focus: { bbox: BBox; kind: FocusKind } | null;
  /** Everything drawn plus the focus region (a saved clip's default crop). */
  bbox: BBox | null;
  xHeight: number;
};

/** A sketch card's size in CSS pixels (K5, NOTEBOOKS_K §3.2: about 320 × 240). */
export const SKETCH_CARD = { width: 320, height: 240 } as const;

/**
 * Loads what sketches need before planning (smiles-drawer's layout runs asynchronously, the
 * planner doesn't): call it with a turn's actions, then `planScreenInk`.
 */
export async function prepareScreenInk(actions: readonly ScreenAction[]): Promise<void> {
  const molecules = actions.flatMap((a) =>
    a.type === "sketch" && a.figure.type === "draw_molecule" ? [a.figure.smiles] : [],
  );
  await Promise.all(molecules.map((smiles) => loadMolecule(smiles)));
}

/** Widest note before wrapping, in x-heights: wide first, narrower for tight margins. */
const WRAP_WIDTHS = [26, 16, 10] as const;
/** Cap on points per turn, so a pathological reply can't flood the overlay. */
const MAX_POINTS = 30_000;
const DEFAULT_PRESSURE = 0.5;

/** Normalised (0–1000) box → overlay pixels within `frame`. */
export function boxToPixels(box: ScreenBox, [fx, fy, fw, fh]: BBox): BBox {
  const left = fx + (box.left / 1000) * fw;
  const top = fy + (box.top / 1000) * fh;
  return [left, top, ((box.right - box.left) / 1000) * fw, ((box.bottom - box.top) / 1000) * fh];
}

export function pointToPixels(point: ScreenPoint, [fx, fy, fw, fh]: BBox): [number, number] {
  return [fx + (point.x / 1000) * fw, fy + (point.y / 1000) * fh];
}

/** Handwriting size from the text around it: a little smaller than the text, never tiny. */
export function screenXHeight(textHeight: number | undefined, scale: number): number {
  if (textHeight === undefined || !(textHeight > 0)) return 10 * scale;
  return clamp(textHeight * 0.6, 7 * scale, 16 * scale);
}

export function planScreenInk(
  actions: readonly ScreenAction[],
  input: ScreenInkInput,
): ScreenInkPlan {
  const planner = new ScreenPlanner(input);
  const focusAction = actions.find((a) => a.type === "focus_region");
  const focus = focusAction
    ? { bbox: boxToPixels(focusAction.box, input.frame), kind: focusAction.kind }
    : null;
  // A video's picture stays readable: notes go around it (brief §2.2.5).
  if (focus?.kind === "video_frame") planner.block(focus.bbox);

  const planned: PlannedScreenAction[] = [];
  const skipped: ScreenInkPlan["skipped"] = [];
  for (const [index, action] of actions.entries()) {
    if (action.type === "focus_region" || action.type === "clear") continue;
    let result: PlannedScreenAction | string;
    try {
      result = planner.draw(action, index);
    } catch {
      result = "failed to draw";
    }
    if (typeof result === "string") skipped.push({ index, type: action.type, reason: result });
    else planned.push(result);
  }

  const boxes = [...planned.map((p) => p.bbox), ...(focus ? [focus.bbox] : [])];
  return {
    actions: planned,
    skipped,
    focus,
    bbox: boxes.length > 0 ? boxes.reduce(unionBBox) : null,
    xHeight: planner.xHeight,
  };
}

type Side = Exclude<NoteSide, "auto">;
const AUTO_ORDER: readonly Side[] = ["right", "left", "below"];

class ScreenPlanner {
  readonly xHeight: number;
  private readonly penWidth: number;
  private readonly gap: number;
  /** Text and ink: where notes may not go. */
  private readonly grid: OccupancyGrid;
  /** Ink only: sticky notes may cover text, never other ink. */
  private readonly inkGrid: OccupancyGrid;
  /** Inside the captured area and the monitor: the only place we know what's underneath. */
  private readonly area: BBox;
  private readonly rng: () => number;
  private points = 0;
  /** Everything drawn so far (sketch cards may sit outside the captured area, never on ink). */
  private readonly inked: BBox[] = [];

  constructor(private readonly input: ScreenInkInput) {
    this.xHeight = screenXHeight(input.textHeight, input.scale);
    this.penWidth = Math.max(1.5 * input.scale, this.xHeight * 0.27);
    this.gap = this.xHeight * 0.8;
    this.area = intersect(input.frame, input.bounds) ?? input.bounds;
    const cell = this.xHeight / 2;
    this.grid = new OccupancyGrid(this.area, cell);
    this.inkGrid = new OccupancyGrid(this.area, cell);
    const clearance = this.xHeight * 0.3;
    for (const box of input.obstacles) this.grid.mark(inflateBBox(box, clearance));
    this.rng = seededRandom(seedFrom(input.seed));
  }

  private snapRegion(box: BBox): BBox {
    return this.input.words ? snapRegion(box, this.input.words) : box;
  }

  private snapLine(box: BBox): BBox {
    return this.input.words ? snapLine(box, this.input.words) : box;
  }

  private snapPoint(point: [number, number]): [number, number] {
    return this.input.words ? snapPoint(point, this.input.words) : point;
  }

  /** Keeps notes off a whole area (a video's picture). */
  block(box: BBox): void {
    this.grid.mark(inflateBBox(box, this.gap / 2));
  }

  draw(
    action: Exclude<ScreenAction, { type: "focus_region" | "clear" }>,
    index: number,
  ): PlannedScreenAction | string {
    const { frame, colors } = this.input;
    switch (action.type) {
      case "circle_region": {
        const box = this.snapRegion(boxToPixels(action.box, frame));
        const color = action.tone === "question" ? (colors.question ?? colors.ink) : colors.ink;
        const ellipse = timed(ellipseAround(box, this.xHeight * 0.35, this.rng));
        const strokes = [this.stroke(ellipse, { color })];
        if (action.label) {
          const label = this.note(action.label, box, "auto", { scale: 0.85, card: false });
          if (label) strokes.push(...label.strokes);
        }
        return this.commit(strokes, action.type, index);
      }
      case "underline": {
        const [x, y, w, h] = this.snapLine(boxToPixels(action.box, frame));
        return this.commit(
          [this.pen(wavyLine([x, y + h + this.xHeight * 0.2], w, this.xHeight * 0.06, this.rng))],
          action.type,
          index,
        );
      }
      case "highlight": {
        const [x, y, w, h] = this.snapLine(boxToPixels(action.box, frame));
        const width = Math.max(h * 0.95, this.xHeight);
        const points = wavyLine([x, y + h / 2], w, this.xHeight * 0.03, this.rng);
        return this.commit(
          [this.stroke(timed(points), { tool: "highlighter", color: colors.highlight, width })],
          action.type,
          index,
        );
      }
      case "check_mark": {
        const tick = this.tickBeside(boxToPixels(action.box, frame));
        return this.commit([this.pen(tick)], action.type, index);
      }
      case "point_at": {
        const target = this.snapPoint(pointToPixels(action.point, frame));
        const arrow = this.arrowTo(target, action.label);
        const planned = this.commit(arrow.strokes, action.type, index, arrow.card);
        return typeof planned === "string" ? planned : { ...planned, target };
      }
      case "sketch":
        return this.sketch(
          action.figure,
          boxToPixels(action.besideBox, frame),
          action.pointTo,
          index,
        );
      case "margin_note":
      case "write_step": {
        const beside = boxToPixels(action.besideBox, frame);
        const text = action.type === "margin_note" ? action.text : action.latexOrText;
        const math = action.type === "write_step" && looksLikeLatex(text);
        const placed = this.note(text, beside, action.side ?? "auto", { math });
        if (!placed) return "nothing drawable";
        return this.commit(placed.strokes, action.type, index, placed.card);
      }
    }
  }

  /**
   * A figure on a paper card beside `target` (K5): right, left, below or above it, on the monitor
   * and off other ink (the card is opaque, so it may sit over content outside the marks). An
   * arrow runs from the card to `pointTo` when given.
   */
  private sketch(
    figure: SketchFigure,
    target: BBox,
    pointTo: ScreenPoint | undefined,
    index: number,
  ): PlannedScreenAction | string {
    const { bounds, scale, colors, frame } = this.input;
    const size: [number, number] = [
      Math.min(SKETCH_CARD.width * scale, bounds[2] - 2 * this.gap),
      Math.min(SKETCH_CARD.height * scale, bounds[3] - 2 * this.gap),
    ];
    const card = this.sketchSpot(size, target);
    if (!card) return "no room for a sketch";
    const pad = this.xHeight * 0.8;
    const drawn = this.figure(figure, {
      rect: [card[0] + pad, card[1] + pad, card[2] - 2 * pad, card[3] - 2 * pad],
      unit: this.xHeight,
      pen: new RoughPen(Math.floor(this.rng() * 2 ** 31), 0.8),
    });
    if (typeof drawn === "string") return drawn;
    const strokes = drawn.paths.map((path) => this.pen(path));
    for (const label of drawn.labels) {
      const box = this.typeset(label.text, 30, label.scale, false);
      if (box.marks.length === 0) continue;
      const w = box.width * this.xHeight;
      const h = (box.ascent + box.descent) * this.xHeight;
      strokes.push(...this.write(box, [label.at[0] - w / 2, label.at[1] - h / 2, w, h]));
    }
    for (const accent of drawn.accents) {
      strokes.push(
        this.stroke(timed(accent), {
          tool: "highlighter",
          color: colors.highlight,
          width: this.xHeight * 0.9,
        }),
      );
    }
    if (pointTo) {
      const tip = this.snapPoint(pointToPixels(pointTo, frame));
      strokes.push(...this.arrowLine(nearestPointOn(card, tip), tip));
    }
    return this.commit(strokes, "sketch", index, card);
  }

  private figure(
    figure: SketchFigure,
    frame: Parameters<typeof geometryFigure>[1],
  ): Figure | string {
    switch (figure.type) {
      case "draw_geometry":
        return geometryFigure(figure.figure, frame);
      case "draw_molecule": {
        const layout = cachedMolecule(figure.smiles);
        if (layout === undefined) return "the molecule wasn't loaded";
        return typeof layout === "string" ? layout : moleculeFigure(layout, figure, frame);
      }
      case "draw_shapes":
        return shapesFigure(figure.shapes, frame);
    }
  }

  /** Beside the target on its right, left, below or above, nearest first; null if none fits. */
  private sketchSpot([w, h]: [number, number], target: BBox): BBox | null {
    const { bounds } = this.input;
    const [tx, ty, tw, th] = target;
    const m = this.gap;
    const keepOff = inflateBBox(target, m / 2);
    const level = clamp(ty + th / 2 - h / 2, bounds[1] + m, bounds[1] + bounds[3] - h - m);
    const across = clamp(tx + tw / 2 - w / 2, bounds[0] + m, bounds[0] + bounds[2] - w - m);
    const spots: BBox[] = [];
    for (let out = 0; out <= 8; out++) {
      const step = out * 2 * m;
      spots.push(
        [tx + tw + m + step, level, w, h],
        [tx - m - w - step, level, w, h],
        [across, ty + th + m + step, w, h],
        [across, ty - m - h - step, w, h],
      );
    }
    return (
      spots.find(
        (spot) =>
          contains(bounds, spot) && !overlapsAny(spot, [keepOff]) && !overlapsAny(spot, this.inked),
      ) ?? null
    );
  }

  /**
   * Writes `text` in free space beside `target` (preferred side first, then the auto order),
   * wrapping narrower to fit tight margins. With no free space, a sticky note at the nearest
   * edge of the captured area, with an arrow to the target (unless `card` is false: a circle's
   * label is left out rather than put on paper).
   */
  private note(
    text: string,
    target: BBox,
    side: NoteSide,
    { scale = 1, math = false, card: allowCard = true } = {},
  ): { strokes: ScreenStroke[]; card?: BBox } | null {
    const sides = side === "auto" ? AUTO_ORDER : [side, ...AUTO_ORDER.filter((s) => s !== side)];
    const layouts = WRAP_WIDTHS.map((maxWidth) => this.typeset(text, maxWidth, scale, math));
    if (layouts.every((box) => box.marks.length === 0)) return null;
    const x = this.xHeight;

    for (const s of sides) {
      for (const box of layouts) {
        const size: [number, number] = [box.width * x, (box.ascent + box.descent) * x];
        for (const [left, top] of besideCandidates(size, target, s, this.gap)) {
          const rect: BBox = [left, top, size[0], size[1]];
          if (this.isFree(rect)) return { strokes: this.write(box, rect) };
        }
      }
    }

    if (!allowCard) return null;
    // Sticky note: the widest layout that fits the area, on paper, pointing at the target.
    const box = layouts.find((b) => b.width * x + 2 * x <= this.area[2] / 2) ?? layouts.at(-1);
    if (!box) return null;
    const pad = 0.6 * x;
    const size: [number, number] = [
      box.width * x + 2 * pad,
      (box.ascent + box.descent) * x + 2 * pad,
    ];
    const card = this.cardSpot(size, target);
    const strokes = this.write(box, [
      card[0] + pad,
      card[1] + pad,
      box.width * x,
      size[1] - 2 * pad,
    ]);
    strokes.push(...this.arrowBetween(nearestPointOn(card, centre(target)), target));
    return { strokes, card };
  }

  /**
   * An arrow to `target` from free space near it, with an optional label at its tail. On a page
   * too full for the label, it goes on a sticky note at the nearest edge and the arrow runs
   * from there: the label is never dropped.
   */
  private arrowTo(
    target: [number, number],
    label: string | undefined,
  ): { strokes: ScreenStroke[]; card?: BBox } {
    const x = this.xHeight;
    const box = label ? this.typeset(label, 16, 0.85, false) : null;
    const size: [number, number] = box ? [box.width * x, (box.ascent + box.descent) * x] : [x, x];
    // Up-left first (arrows read best coming from above), then around, further and further.
    const angles = [-135, -45, 180, 0, 135, 45, -90, 90].map((d) => (d * Math.PI) / 180);
    for (const radius of [4, 5.5, 7, 9, 12, 16, 22].map((r) => r * x)) {
      for (const angle of angles) {
        const tip: [number, number] = [
          target[0] + Math.cos(angle) * radius,
          target[1] + Math.sin(angle) * radius,
        ];
        const rect: BBox = [tip[0] - size[0] / 2, tip[1] - size[1] / 2, size[0], size[1]];
        if (!this.isFree(rect)) continue;
        const strokes = box ? this.write(box, rect) : [];
        const tail = nearestPointOn(rect, target);
        return { strokes: [...strokes, ...this.arrowLine(tail, target)] };
      }
    }
    if (box && box.marks.length > 0) {
      const pad = 0.6 * x;
      const card = this.cardSpot([size[0] + 2 * pad, size[1] + 2 * pad], [...target, 0, 0]);
      const strokes = this.write(box, [card[0] + pad, card[1] + pad, size[0], size[1]]);
      strokes.push(...this.arrowLine(nearestPointOn(card, target), target));
      return { strokes, card };
    }
    // Nowhere free and nothing to write: still point, from up-left (an arrow may cross text).
    const tail: [number, number] = [target[0] - 3 * x, target[1] - 3 * x];
    return { strokes: this.arrowLine(clampPoint(tail, this.area), target) };
  }

  private arrowBetween(from: [number, number], target: BBox): ScreenStroke[] {
    return this.arrowLine(from, nearestPointOn(inflateBBox(target, this.gap / 2), from));
  }

  /** A gently curved arrow, its tip stopping just short of the target. */
  private arrowLine(from: [number, number], to: [number, number]): ScreenStroke[] {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const length = Math.hypot(dx, dy);
    if (length < this.xHeight) return [];
    const ux = dx / length;
    const uy = dy / length;
    const tip: [number, number] = [
      to[0] - ux * this.xHeight * 0.3,
      to[1] - uy * this.xHeight * 0.3,
    ];
    const bend = (0.12 + 0.05 * signed(this.rng)) * length;
    const control: [number, number] = [
      (from[0] + tip[0]) / 2 - uy * bend,
      (from[1] + tip[1]) / 2 + ux * bend,
    ];
    const shaft: [number, number][] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const a = (1 - t) * (1 - t);
      const b = 2 * (1 - t) * t;
      const c = t * t;
      shaft.push([
        a * from[0] + b * control[0] + c * tip[0],
        a * from[1] + b * control[1] + c * tip[1],
      ]);
    }
    // The head follows the curve's direction at the tip.
    const [px, py] = shaft[shaft.length - 2] ?? from;
    const angle = Math.atan2(tip[1] - py, tip[0] - px);
    const head = this.xHeight * 0.9;
    const wing = (side: number): [number, number][] => [
      [tip[0] - Math.cos(angle + side * 0.5) * head, tip[1] - Math.sin(angle + side * 0.5) * head],
      tip,
    ];
    return [this.pen(shaft), this.pen(wing(1)), this.pen(wing(-1))];
  }

  /** Where a sticky note goes: along the edge of the area nearest the target, off other ink. */
  private cardSpot([w, h]: [number, number], target: BBox): BBox {
    const [ax, ay, aw, ah] = this.area;
    const m = this.gap;
    const [cx, cy] = centre(target);
    const y = clamp(cy - h / 2, ay + m, ay + ah - h - m);
    const x = clamp(cx - w / 2, ax + m, ax + aw - w - m);
    const spots: BBox[] = [
      [ax + aw - w - m, y, w, h],
      [ax + m, y, w, h],
      [x, ay + ah - h - m, w, h],
      [x, ay + m, w, h],
    ];
    const distance = (b: BBox) => Math.hypot(centre(b)[0] - cx, centre(b)[1] - cy);
    spots.sort((a, b) => distance(a) - distance(b));
    const clear = (b: BBox) => this.inkGrid.isFree(b) && !overlapsAny(b, [target]);
    return spots.find(clear) ?? spots.find((b) => this.inkGrid.isFree(b)) ?? spots[0] ?? target;
  }

  private typeset(text: string, maxWidth: number, scale: number, math: boolean): Box {
    return math ? typesetLatex(text, { maxWidth }).box : typesetText(text, { maxWidth, scale }).box;
  }

  private write(box: Box, rect: BBox): ScreenStroke[] {
    const origin: [number, number] = [rect[0], rect[1] + box.ascent * this.xHeight];
    return inkify(box, origin, { xHeight: this.xHeight, rng: this.rng }).map((points) =>
      this.stroke(points),
    );
  }

  private isFree(rect: BBox): boolean {
    return contains(this.area, rect) && this.grid.isFree(rect) && this.inkGrid.isFree(rect);
  }

  /**
   * A small tick beside a line of text (Notes Check: "your notes have this"): in the free space
   * just right of it, else just left, else at its right edge anyway; never over the words.
   */
  private tickBeside(target: BBox): [number, number][] {
    const size = this.xHeight * 1.3;
    const [x, y, w, h] = target;
    const top = y + h / 2 - size / 2;
    const spots: [number, number][] = [
      [x + w + this.gap / 2, top],
      [x - this.gap / 2 - size, top],
    ];
    const [left, tickTop] = spots.find(([sx, sy]) => this.isFree([sx, sy, size, size])) ??
      spots[0] ?? [x + w, top];
    return [
      [left, tickTop + size * 0.55],
      [left + size * 0.35, tickTop + size],
      [left + size, tickTop],
    ];
  }

  /** A free-hand pen path. */
  private pen(path: readonly (readonly [number, number])[]): ScreenStroke {
    return this.stroke(timed(path));
  }

  private stroke(
    points: Point[],
    {
      tool = "pen",
      color = this.input.colors.ink,
      width = this.penWidth,
    }: Partial<Pick<ScreenStroke, "tool" | "color" | "width">> = {},
  ): ScreenStroke {
    return { tool, color, width, points, bbox: strokeBBox(points, width) };
  }

  /** Reserves the ink's space (with clearance) and caps the turn's points. */
  private commit(
    strokes: ScreenStroke[],
    type: ScreenAction["type"],
    index: number,
    card?: BBox,
  ): PlannedScreenAction | string {
    const first = strokes[0];
    if (!first) return "nothing drawable";
    this.points += strokes.reduce((n, s) => n + s.points.length, 0);
    if (this.points > MAX_POINTS) return "too much ink";
    let bbox = strokes.map((s) => s.bbox).reduce(unionBBox, first.bbox);
    if (card) bbox = unionBBox(bbox, card);
    const reserved = inflateBBox(bbox, this.xHeight * 0.3);
    this.grid.mark(reserved);
    this.inkGrid.mark(reserved);
    this.inked.push(reserved);
    return { index, type, strokes, bbox, ...(card && { card }) };
  }
}

/**
 * Candidate top-left corners for a box of `size` on one side of `target`, nearest first: right
 * and left step down the target's height (a hint sits level with its question), below steps
 * across its width.
 */
export function* besideCandidates(
  [w, h]: readonly [number, number],
  [tx, ty, tw, th]: BBox,
  side: Side,
  gap: number,
): Generator<[number, number]> {
  const step = gap / 2;
  const rows = Math.max(0, Math.ceil((th - h) / step)) + 2;
  if (side === "right" || side === "left") {
    for (let out = 0; out <= 6; out++) {
      const x = side === "right" ? tx + tw + gap + out * gap : tx - gap - w - out * gap;
      for (let k = -1; k <= rows; k++) yield [x, ty + k * step];
    }
    return;
  }
  const columns = Math.max(0, Math.ceil((tw - w) / step)) + 1;
  for (let down = 0; down <= 10; down++) {
    for (let k = 0; k <= columns; k++) yield [tx + k * step, ty + th + gap + down * step];
  }
}

/** A hand-drawn loop around a box: slightly uneven, overlapping where it closes. */
function ellipseAround(box: BBox, pad: number, rng: () => number): [number, number][] {
  const [x, y, w, h] = inflateBBox(box, pad);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const phase = signed(rng) * Math.PI;
  const start = -2.3 + signed(rng) * 0.2;
  const sweep = 2 * Math.PI + 0.35;
  const steps = 56;
  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = start + (sweep * i) / steps;
    const wobble = 1 + 0.035 * Math.sin(3 * t + phase);
    const drift = 1 + 0.06 * (i / steps);
    points.push([cx + (w / 2) * wobble * drift * Math.cos(t), cy + (h / 2) * wobble * Math.sin(t)]);
  }
  return points;
}

/** A nearly straight line from `start`, `length` long, with a little hand-drawn waver. */
function wavyLine(
  [x, y]: readonly [number, number],
  length: number,
  amplitude: number,
  rng: () => number,
): [number, number][] {
  const steps = Math.max(8, Math.min(48, Math.round(length / 6)));
  const phase = signed(rng) * Math.PI;
  const tilt = signed(rng) * amplitude;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return [x + t * length, y + tilt * (t - 0.5) * 2 + amplitude * Math.sin(phase + t * 9)];
  });
}

/** A free-hand path as stroke points, timed at a steady drawing speed (8 ms per point). */
function timed(path: readonly (readonly [number, number])[]): Point[] {
  return path.map(([x, y], i) => [x, y, DEFAULT_PRESSURE, i * 8]);
}

/** LaTeX-ish: has a backslash command, a script or braces. Plain words go as text. */
function looksLikeLatex(text: string): boolean {
  return /\\[a-zA-Z]|[\^_{}]/.test(text);
}

function centre([x, y, w, h]: BBox): [number, number] {
  return [x + w / 2, y + h / 2];
}

function nearestPointOn([x, y, w, h]: BBox, [px, py]: readonly [number, number]): [number, number] {
  return [clamp(px, x, x + w), clamp(py, y, y + h)];
}

function clampPoint([px, py]: [number, number], [x, y, w, h]: BBox): [number, number] {
  return [clamp(px, x, x + w), clamp(py, y, y + h)];
}

function intersect(a: BBox, b: BBox): BBox | null {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  return right > left && bottom > top ? [left, top, right - left, bottom - top] : null;
}

function contains(outer: BBox, inner: BBox): boolean {
  return (
    inner[0] >= outer[0] &&
    inner[1] >= outer[1] &&
    inner[0] + inner[2] <= outer[0] + outer[2] &&
    inner[1] + inner[3] <= outer[1] + outer[3]
  );
}

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(max, Math.max(min, value));
}
