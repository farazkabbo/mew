import type { ImageEntry } from "@mew/shared";

/**
 * Replaying an entry's explanation (Circle & Ask, S3.2 §5): every step's ink is hidden, then
 * shown again one step at a time, at about the pace it was said, while the note highlights the
 * step's words. No model call: it's the ink already on the page.
 */

/** A step to show: which turn and step, and its ink's group. */
export type ReplayStep = { turn: number; step: number; group: string };

/** Reading time per word, and at least this long per step (as captions are timed). */
const PER_WORD_MS = 250;
const AT_LEAST_MS = 1400;

/** The entry's steps in the order they were explained. */
export function replaySteps(entry: ImageEntry): ReplayStep[] {
  return entry.stepGroups.flatMap((groups, turn) =>
    groups.map((group, step) => ({ turn, step, group })),
  );
}

/** How long a step stays the newest one before the next appears. */
export function stepMs(entry: ImageEntry, { turn, step }: ReplayStep): number {
  const words = entry.turns[turn]?.steps[step]?.split(/\s+/).filter(Boolean).length ?? 0;
  return Math.max(AT_LEAST_MS, words * PER_WORD_MS);
}

/**
 * Runs a replay: `hide` gets the groups still hidden (all, then fewer, then none), `onStep`
 * the step being shown (null at the end). Returns a function that stops it (and shows all).
 */
export function replayEntry(
  entry: ImageEntry,
  hide: (groups: ReadonlySet<string>) => void,
  onStep: (step: ReplayStep | null) => void,
  timers: {
    set: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clear: (timer: ReturnType<typeof setTimeout>) => void;
  } = {
    // Wrapped: the browser's timers must be called on the window, not on this object.
    set: (run, ms) => setTimeout(run, ms),
    clear: (timer) => clearTimeout(timer),
  },
): () => void {
  const steps = replaySteps(entry);
  const hidden = new Set(steps.map((s) => s.group));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let index = 0;
  const finish = () => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
    hide(new Set());
    onStep(null);
  };
  const show = () => {
    const step = steps[index];
    if (!step) return finish();
    hidden.delete(step.group);
    hide(new Set(hidden));
    onStep(step);
    index++;
    timer = timers.set(show, stepMs(entry, step));
  };
  hide(new Set(hidden));
  // A beat with nothing, so the first step visibly draws in.
  timer = timers.set(show, 300);
  return finish;
}
