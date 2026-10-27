import { planScreenInk, prepareScreenInk, type ScreenStroke, strokePath } from "@mew/ink";
import { type BBox, HexColor, ScreenAction } from "@mew/shared";
import { z } from "zod";

import { schedule, visiblePoints } from "./animation";
import { invoke, on } from "./tauri";

/**
 * Screen Coach's ink overlay (S3): a transparent, click-through window over one monitor. Rust
 * sends what to draw (the tutor's actions, where the capture is, and the on-screen text as
 * rectangles only, never the words); this page plans the ink with the notebook's handwriting,
 * reports the strokes back (a saved clip keeps them as vectors), and draws them.
 *
 * Everything is in physical pixels of the monitor: the canvas has one pixel per screen pixel.
 *
 * Circle & Ask (S3.2) draws an explanation a step at a time: a request with `step` > 0 keeps the
 * earlier steps' ink on screen, and is planned clear of it.
 */

const Rect = z.tuple([z.number(), z.number(), z.number().min(0), z.number().min(0)]);

const InkRequest = z.object({
  id: z.number().int().nonnegative(),
  seed: z.string().max(100),
  /** The tutor's ink (at most 8 actions), or a notes check's marks (up to 24). */
  actions: z.array(ScreenAction).max(24),
  frame: Rect,
  bounds: Rect,
  obstacles: z.array(Rect).max(20_000),
  textHeight: z.number().positive().optional(),
  scale: z.number().min(1).max(8),
  colors: z.object({ ink: HexColor, highlight: HexColor, question: HexColor.optional() }),
  animate: z.boolean(),
  step: z.number().int().min(0).max(4).optional(),
});
type InkRequest = z.infer<typeof InkRequest>;

/** A sticky note's paper: warm, nearly opaque, readable over any content. */
const CARD_FILL = "rgba(255, 252, 242, 0.95)";
const CARD_EDGE = "rgba(138, 123, 240, 0.45)";
const FADE_MS = 150;
/** Notes Check's ticks are a quiet "you've got this": they fade on their own (brief §8). */
const TICK_VISIBLE_MS = 4000;

const canvas = document.querySelector("canvas");
const ctx = canvas?.getContext("2d") ?? null;
let frame = 0;
let tickTimer = 0;

/** Ink already on screen from earlier steps of the same explanation. */
type Kept = { strokes: ScreenStroke[]; cards: number[][]; boxes: BBox[] };
const nothingKept = (): Kept => ({ strokes: [], cards: [], boxes: [] });
let kept = nothingKept();

function resize(): void {
  if (!canvas) return;
  canvas.width = Math.round(window.innerWidth * window.devicePixelRatio);
  canvas.height = Math.round(window.innerHeight * window.devicePixelRatio);
}

/**
 * Requests are drawn in order, each after what it needs has loaded (a sketch's molecule layout,
 * K5). A clear drops requests still waiting.
 */
let queue: Promise<void> = Promise.resolve();
let generation = 0;

function clear(): void {
  generation++;
  wipe();
}

function wipe(): void {
  cancelAnimationFrame(frame);
  window.clearTimeout(tickTimer);
  kept = nothingKept();
  if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function draw(detail: unknown): void {
  const parsed = InkRequest.safeParse(detail);
  if (!parsed.success) return;
  const request = parsed.data;
  const queued = generation;
  queue = queue
    .then(() => prepareScreenInk(request.actions))
    .then(() => {
      if (queued === generation) paint(request);
    })
    .catch(() => undefined);
}

function paint(request: InkRequest): void {
  if (!canvas || !ctx) return;
  const appending = (request.step ?? 0) > 0;
  if (appending) {
    // Finish the earlier step's animation at once: it's kept, drawn in full.
    cancelAnimationFrame(frame);
  } else {
    wipe();
    resize();
  }
  canvas.classList.remove("faded");
  const earlier = kept;

  const plan = planScreenInk(request.actions, {
    frame: request.frame,
    bounds: request.bounds,
    obstacles: [...request.obstacles, ...earlier.boxes],
    // The desktop's obstacles are the on-screen words: the model's targets snap onto them.
    words: request.obstacles,
    textHeight: request.textHeight,
    scale: request.scale,
    seed: request.seed,
    colors: request.colors,
  });
  const strokes = plan.actions.flatMap((a) => a.strokes);
  const ticks = new Set(
    plan.actions.filter((a) => a.type === "check_mark").flatMap((a) => a.strokes),
  );
  let showTicks = true;
  const cards = plan.actions.flatMap((a) => (a.card ? [a.card] : []));
  report(request, strokes, cards, plan.bbox);
  kept = {
    strokes: [...earlier.strokes, ...strokes],
    cards: [...earlier.cards, ...cards],
    boxes: plan.bbox ? [...earlier.boxes, plan.bbox] : earlier.boxes,
  };

  const timing = schedule(strokes);
  const started = performance.now();
  const render = (now: number) => {
    const elapsed = request.animate ? now - started : Number.POSITIVE_INFINITY;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const card of [...earlier.cards, ...cards]) paintCard(ctx, card, request.scale);
    for (const stroke of earlier.strokes) {
      ctx.fillStyle = stroke.color;
      ctx.fill(new Path2D(strokePath(stroke, true)));
    }
    strokes.forEach((stroke, i) => {
      if (!showTicks && ticks.has(stroke)) return;
      const shown = visiblePoints(stroke.points, timing.starts[i] ?? 0, timing.speed, elapsed);
      if (shown === 0) return;
      const complete = shown >= stroke.points.length;
      const points = complete ? stroke.points : stroke.points.slice(0, shown);
      ctx.fillStyle = stroke.color;
      ctx.fill(new Path2D(strokePath({ ...stroke, points }, complete)));
    });
    if (request.animate && now - started < timing.totalMs) frame = requestAnimationFrame(render);
  };
  frame = requestAnimationFrame(render);
  if (ticks.size > 0) {
    tickTimer = window.setTimeout(() => {
      showTicks = false;
      frame = requestAnimationFrame(render);
    }, timing.totalMs + TICK_VISIBLE_MS);
  }
}

function paintCard(context: CanvasRenderingContext2D, [x, y, w, h]: number[], scale: number) {
  if (w === undefined || h === undefined || x === undefined || y === undefined) return;
  context.beginPath();
  context.roundRect(x, y, w, h, 8 * scale);
  context.fillStyle = CARD_FILL;
  context.fill();
  context.lineWidth = scale;
  context.strokeStyle = CARD_EDGE;
  context.stroke();
}

/** Tells Rust what was drawn (in the same pixels), so a clip can keep it as editable ink. */
function report(
  request: InkRequest,
  strokes: readonly ScreenStroke[],
  cards: readonly number[][],
  bbox: readonly number[] | null,
): void {
  void invoke("screen_ink_drawn", {
    ink: {
      id: request.id,
      strokes: strokes.map(({ tool, color, width, points }) => ({ tool, color, width, points })),
      cards,
      bbox,
      ...(request.step !== undefined && { step: request.step }),
    },
  }).catch(() => undefined);
}

function fade(): void {
  if (!canvas) return;
  canvas.classList.add("faded");
  window.setTimeout(clear, FADE_MS);
}

on("mew:ink-draw", draw);
on("mew:ink-fade", fade);
on("mew:ink-clear", clear);
window.addEventListener("resize", resize);
resize();
