import type { BBox, BoardAction, Stroke } from "@mew/shared";
import {
  type BoardColors,
  type BoardInput,
  type BoardPlan,
  currentLine,
  planBoard,
  type PlannedAction,
  relocateAction,
  type SkippedAction,
  ALL_RENDERERS,
  unionBBox,
} from "@mew/ink";

import type { PageEngine } from "../notebook/engine";
import { studentLines } from "../notebook/export-line";

/** Something that can draw the tutor's in-progress ink (the canvas's live layer). */
export type InkLayer = {
  /** Strokes to draw right now: finished ones plus the one being written. */
  liveStrokes(): readonly Stroke[];
  subscribe(listener: () => void): () => void;
};

export type InkClock = {
  now(): number;
  frame(callback: () => void): () => void;
  timeout(callback: () => void, ms: number): () => void;
};

export const browserInkClock: InkClock = {
  now: () => performance.now(),
  frame: (callback) => {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  },
  timeout: (callback, ms) => {
    const id = window.setTimeout(callback, ms);
    return () => window.clearTimeout(id);
  },
};

export type TutorInkDeps = {
  engine(): PageEngine | null;
  colors(): BoardColors;
  newId?: () => string;
  clock?: InkClock;
  /** Renderers by action type (M4 text and marks; visuals plug in here). */
  renderers?: Parameters<typeof planBoard>[2];
  /**
   * Time (ms) before the first stroke, for the notebook's pointer to glide to where the ink
   * starts (K6 §6.3); 0 (the default) with reduced motion, when the pointer just appears.
   */
  leadInMs?: () => number;
};

export type InkResult = {
  strokes: number;
  skipped: SkippedAction[];
  missing: string[];
  /** The turn's stroke group (one undo step; Show-then-You folds a solution by it). */
  groupId: string;
  /** Everything planned, on the page. */
  bbox: BBox | null;
};

/** Plans ink without the model's actions (Show-then-You's boxed answer and Your Turn box). */
export type CustomPlan = (input: BoardInput) => BoardPlan | Promise<BoardPlan>;

/** Pause between strokes (pen lift) and between actions, in ms of natural writing time. */
const PEN_LIFT_MS = 60;
const ACTION_GAP_MS = 250;
/** The student must be quiet (pen and voice) this long before paused ink resumes. */
const RESUME_AFTER_IDLE_MS = 1500;
/** Roughly how long the tutor takes to say each character, to pace writing to speech. */
const SPEECH_MS_PER_CHAR = 60;
const PACE = { minMs: 1200, maxMs: 7000, minRate: 0.6, maxRate: 3 };
const FALLBACK_VIEWPORT: BBox = [0, 0, 1200, 800];

type Timed = { stroke: Stroke; start: number; end: number; action: number };

type Animation = {
  engine: PageEngine;
  input: Parameters<typeof relocateAction>[1];
  actions: PlannedAction[];
  timeline: Timed[];
  /** Animation time (ms) at which everything is written. */
  total: number;
  /** Natural-to-animation time multiplier: >1 writes faster. */
  rate: number;
  elapsed: number;
  lastTick: number | null;
  paused: boolean;
  onStart?: (() => void) | undefined;
  started: boolean;
};

/**
 * Draws the tutor's board actions as ink that writes itself: plans them (layout, size, placement)
 * when the response arrives, animates them on the live layer paced to the speech, and commits
 * them to the page as one undo step when done. Writing pauses when the student barges in and
 * resumes once they've been quiet for a moment.
 */
export class TutorInk implements InkLayer {
  private animation: Animation | null = null;
  /** Bumped by every render and finish, so a slow plan can tell it was superseded. */
  private generation = 0;
  private viewportOf: (() => BBox) | null = null;
  private readonly listeners = new Set<() => void>();
  private cancelFrame: (() => void) | null = null;
  private cancelResume: (() => void) | null = null;
  private readonly clock: InkClock;
  private readonly newId: () => string;
  /** Waiting for the ink being written to be on the page (`written()`). */
  private waiters: (() => void)[] = [];

  constructor(private readonly deps: TutorInkDeps) {
    this.clock = deps.clock ?? browserInkClock;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /** The canvas tells us what's on screen, so ink lands where the student is looking. */
  /** The page area on screen (where new ink should land), or a default before it's known. */
  viewport(): BBox {
    return this.viewportOf?.() ?? FALLBACK_VIEWPORT;
  }

  attachViewport(viewport: () => BBox): () => void {
    this.viewportOf = viewport;
    return () => {
      if (this.viewportOf === viewport) this.viewportOf = null;
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get busy(): boolean {
    return this.animation !== null;
  }

  /** Resolves once nothing is being written (now, if nothing is). */
  written(): Promise<void> {
    if (!this.animation) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * Where the pen is (page coordinates): the end of the stroke being written, or of the last one
   * written; null when nothing is being written. The notebook's pointer follows it (K6 §6.3).
   */
  tip(): [number, number] | null {
    const a = this.animation;
    if (!a) return null;
    let tip: [number, number] | null = null;
    for (const { stroke, start, end } of a.timeline) {
      if (a.elapsed <= start) {
        // Not started yet: the pen waits where the next stroke begins.
        const first = stroke.points[0];
        tip ??= first ? [first[0], first[1]] : null;
        break;
      }
      const points =
        a.elapsed >= end ? stroke.points : partial(stroke, (a.elapsed - start) * a.rate).points;
      const last = points.at(-1);
      if (last) tip = [last[0], last[1]];
    }
    return tip;
  }

  liveStrokes(): readonly Stroke[] {
    const a = this.animation;
    if (!a) return [];
    const shown: Stroke[] = [];
    for (const { stroke, start, end } of a.timeline) {
      if (a.elapsed >= end) shown.push(stroke);
      else if (a.elapsed > start) shown.push(partial(stroke, (a.elapsed - start) * a.rate));
      else break;
    }
    return shown;
  }

  /**
   * Plans and starts writing a turn's actions. Any ink still being written from an earlier turn
   * is committed first. `speech` paces the writing to roughly match how long it takes to say.
   * `nearStrokes` makes the line holding those strokes the active one (e.g. Notes Check writes a
   * gap's heading under the line it follows), instead of the line written last.
   */
  async render(
    actions: readonly BoardAction[],
    {
      speech = "",
      onStart,
      nearStrokes,
      groupId = this.newId(),
      plan: custom,
      instant = false,
    }: {
      speech?: string;
      onStart?: () => void;
      nearStrokes?: readonly string[];
      groupId?: string;
      plan?: CustomPlan;
      /** Put it on the page at once, without writing it out (ink made while nobody watches). */
      instant?: boolean;
    } = {},
  ): Promise<InkResult> {
    this.finish();
    const generation = ++this.generation;
    const engine = this.deps.engine();
    const none = { strokes: 0, skipped: [], missing: [], groupId, bbox: null };
    if (!engine || (actions.length === 0 && !custom)) return none;

    const input = this.boardInput(engine, groupId, nearStrokes);
    // Planning is async (graph layout): a newer turn may start meanwhile.
    const plan: BoardPlan = custom
      ? await custom(input)
      : await planBoard(actions, input, this.deps.renderers ?? ALL_RENDERERS);
    const strokes = plan.actions.reduce((n, a) => n + a.strokes.length, 0);
    const boxes = plan.actions.map((a) => a.bbox);
    const result: InkResult = {
      strokes,
      skipped: plan.skipped,
      missing: plan.missing,
      groupId,
      bbox: boxes.length > 0 ? boxes.reduce(unionBBox) : null,
    };
    if (strokes === 0) return result;
    if (instant) {
      engine.addTutorStrokes(plan.actions.flatMap((a) => a.strokes));
      return result;
    }
    if (generation !== this.generation) {
      // Superseded while planning: the ink still belongs on its page, just without animating.
      engine.addTutorStrokes(plan.actions.flatMap((a) => a.strokes));
      return result;
    }

    const { timeline, natural } = schedule(plan.actions);
    const target = clamp(speech.length * SPEECH_MS_PER_CHAR, PACE.minMs, PACE.maxMs);
    const rate = clamp(natural / target, PACE.minRate, PACE.maxRate);
    const leadIn = Math.max(0, this.deps.leadInMs?.() ?? 0);
    this.animation = {
      engine,
      input,
      actions: plan.actions,
      timeline: timeline.map((t) => ({
        ...t,
        start: leadIn + t.start / rate,
        end: leadIn + t.end / rate,
      })),
      total: leadIn + natural / rate,
      rate,
      elapsed: 0,
      lastTick: null,
      paused: false,
      onStart,
      started: false,
    };
    this.tick();
    return result;
  }

  /** The student is writing or speaking: hold the pen until they've been quiet for a moment. */
  pause(): void {
    const a = this.animation;
    if (!a) return;
    a.paused = true;
    a.lastTick = null;
    this.cancelResume?.();
    this.cancelResume = this.clock.timeout(() => this.resume(), RESUME_AFTER_IDLE_MS);
  }

  /** Commits everything still pending (e.g. a new turn starts, or the page closes). */
  finish(): void {
    this.generation++; // a plan still being made lands directly instead of animating
    const a = this.animation;
    if (!a) return;
    this.stop();
    // Cut short while paused: the student may have written where the rest was going.
    if (a.paused) this.relocateBlocked(a);
    a.engine.addTutorStrokes(a.timeline.map((t) => t.stroke));
    this.emit();
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  /** The session ends: nothing is left half-written. (Listeners unsubscribe themselves.) */
  dispose(): void {
    this.finish();
  }

  private resume(): void {
    const a = this.animation;
    this.cancelResume = null;
    if (!a?.paused) return;
    this.relocateBlocked(a);
    a.paused = false;
    this.tick();
  }

  /**
   * The ink isn't on the page yet, so if the student wrote where it's going (even over a half
   * written part), it moves out of their way. Marks stay put: they belong on their line.
   */
  private relocateBlocked(a: Animation): void {
    const input = {
      ...this.boardInput(a.engine, a.input.groupId),
      strokes: [...a.engine.doc.all()],
    };
    const moved = new Map<number, PlannedAction>();
    for (const action of a.actions) {
      if (action.type === "mark_error" || action.type === "mark_correct") {
        input.strokes.push(...action.strokes);
        continue;
      }
      const next = relocateAction(action, input);
      if (next !== action) {
        moved.set(action.index, next);
        input.strokes.push(...next.strokes);
      } else {
        input.strokes.push(...action.strokes);
      }
    }
    if (moved.size === 0) return;
    a.actions = a.actions.map((action) => moved.get(action.index) ?? action);
    const byId = new Map(
      a.actions.flatMap((action) => action.strokes.map((s) => [s.id, s] as const)),
    );
    a.timeline = a.timeline.map((t) => ({ ...t, stroke: byId.get(t.stroke.id) ?? t.stroke }));
  }

  private tick = (): void => {
    this.cancelFrame = null;
    const a = this.animation;
    if (!a || a.paused) return;
    const now = this.clock.now();
    if (a.lastTick !== null) a.elapsed += now - a.lastTick;
    a.lastTick = now;
    if (!a.started) {
      a.started = true;
      a.onStart?.();
    }
    if (a.elapsed >= a.total) {
      this.finish();
      return;
    }
    this.emit();
    this.cancelFrame = this.clock.frame(this.tick);
  };

  private stop(): void {
    this.cancelFrame?.();
    this.cancelFrame = null;
    this.cancelResume?.();
    this.cancelResume = null;
    this.animation = null;
  }

  private boardInput(engine: PageEngine, groupId: string, nearStrokes?: readonly string[]) {
    const lines = studentLines(engine.doc);
    const near = nearStrokes && new Set(nearStrokes);
    const nearLine = near && lines.find((line) => line.strokeIds.some((id) => near.has(id)));
    return {
      pageId: engine.pageId,
      groupId,
      strokes: [...engine.doc.all()],
      lines,
      activeLine: nearLine ?? currentLine(lines),
      obstacles: engine.images.map((i): BBox => [i.x, i.y, i.width, i.height]),
      viewport: this.viewportOf?.() ?? FALLBACK_VIEWPORT,
      colors: this.deps.colors(),
      now: Date.now(),
      newId: this.newId,
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Natural-speed timeline: strokes in order, with pen lifts and pauses between actions. */
function schedule(actions: readonly PlannedAction[]): {
  timeline: Timed[];
  natural: number;
} {
  const timeline: Timed[] = [];
  let at = 0;
  actions.forEach((action, i) => {
    if (i > 0) at += ACTION_GAP_MS;
    action.strokes.forEach((stroke, j) => {
      if (j > 0) at += PEN_LIFT_MS;
      const duration = stroke.points.at(-1)?.[3] ?? 0;
      timeline.push({ stroke, start: at, end: at + duration, action: action.index });
      at += duration;
    });
  });
  return { timeline, natural: at };
}

/** The part of a stroke written within `ms` of natural writing time. */
function partial(stroke: Stroke, ms: number): Stroke {
  const points = stroke.points.filter((p) => p[3] <= ms);
  return { ...stroke, points: points.length > 0 ? points : stroke.points.slice(0, 1) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
