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

/** After a step's own voice ends, a beat before the next one. */
const AFTER_VOICE_MS = 350;

type Timers = {
  set: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (timer: ReturnType<typeof setTimeout>) => void;
};

const browserTimers: Timers = {
  // Wrapped: the browser's timers must be called on the window, not on this object.
  set: (run, ms) => setTimeout(run, ms),
  clear: (timer) => clearTimeout(timer),
};

/**
 * Runs a replay: `hide` gets the groups still hidden (all, then fewer, then none), `onStep`
 * the step being shown (null at the end). Returns a function that stops it (and shows all).
 *
 * With `voice` (K8 §4.7: "Replay … with the original voice"), each step is said with the audio
 * kept when it was explained: the next step comes once it's been said (and was shown at least
 * as long as a step always is). A step whose voice wasn't kept (`voice` resolves false) is timed
 * like a caption, as before.
 */
export function replayEntry(
  entry: ImageEntry,
  hide: (groups: ReadonlySet<string>) => void,
  onStep: (step: ReplayStep | null) => void,
  timers: Timers = browserTimers,
  voice?: (step: ReplayStep) => Promise<boolean>,
): () => void {
  const steps = replaySteps(entry);
  const hidden = new Set(steps.map((s) => s.group));
  const pending = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;
  let index = 0;
  const after = (ms: number, run: () => void) => {
    const timer = timers.set(() => {
      pending.delete(timer);
      run();
    }, ms);
    pending.add(timer);
  };
  const wait = (ms: number) => new Promise<void>((resolve) => after(ms, resolve));
  const finish = () => {
    if (stopped) return;
    stopped = true;
    for (const timer of pending) timers.clear(timer);
    pending.clear();
    hide(new Set());
    onStep(null);
  };
  const show = () => {
    if (stopped) return;
    const step = steps[index];
    if (!step) return finish();
    hidden.delete(step.group);
    hide(new Set(hidden));
    onStep(step);
    index++;
    if (!voice) {
      after(stepMs(entry, step), show);
      return;
    }
    const said = voice(step)
      .catch(() => false)
      .then((played) => (played ? wait(AFTER_VOICE_MS) : wait(stepMs(entry, step))));
    void Promise.all([said, wait(AT_LEAST_MS)]).then(show);
  };
  hide(new Set(hidden));
  // A beat with nothing, so the first step visibly draws in.
  after(300, show);
  return finish;
}
