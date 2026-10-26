import type { Stroke } from "@mew/shared";

/**
 * Page Replay (K9 §7.3: "watch how this page was solved"): every stroke on the page, the
 * student's and the tutor's (its live marks included), drawn again in the order it was made.
 * Real pauses are kept but shortened, so a page written over an hour replays in under a minute.
 */

/** A pause longer than this between strokes is cut to it. */
const MAX_GAP_MS = 700;
/** Never faster than this between strokes (a quick burst still reads as writing). */
const MIN_GAP_MS = 40;
/** The whole replay at most (long pages go faster). */
const MAX_TOTAL_MS = 45_000;

export type ReplayFrame = { at: number; ids: string[] };

/** When each stroke appears, from the start of the replay (strokes made together, together). */
export function pageReplayPlan(strokes: readonly Stroke[]): ReplayFrame[] {
  const ordered = [...strokes].sort((a, b) => a.createdAt - b.createdAt);
  const frames: ReplayFrame[] = [];
  let at = 0;
  let previous: number | null = null;
  for (const stroke of ordered) {
    if (previous !== null) {
      const gap = stroke.createdAt - previous;
      if (gap > 0) at += Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, gap));
    }
    previous = stroke.createdAt;
    const last = frames.at(-1);
    if (last && last.at === at) last.ids.push(stroke.id);
    else frames.push({ at, ids: [stroke.id] });
  }
  const total = frames.at(-1)?.at ?? 0;
  if (total <= MAX_TOTAL_MS) return frames;
  const squeeze = MAX_TOTAL_MS / total;
  return frames.map((f) => ({ ...f, at: Math.round(f.at * squeeze) }));
}

/**
 * Runs a replay: `hide` gets the strokes still hidden (all, then fewer, then none). Returns a
 * function that stops it (everything shows again).
 */
export function replayPage(
  strokes: readonly Stroke[],
  hide: (ids: ReadonlySet<string>) => void,
  onDone: () => void,
  timers: {
    set: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clear: (timer: ReturnType<typeof setTimeout>) => void;
  } = { set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer) },
): () => void {
  const frames = pageReplayPlan(strokes);
  const hidden = new Set(strokes.map((s) => s.id));
  const pending: ReturnType<typeof setTimeout>[] = [];
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const timer of pending) timers.clear(timer);
    hide(new Set());
    onDone();
  };
  hide(new Set(hidden));
  const START_MS = 400;
  for (const frame of frames) {
    pending.push(
      timers.set(() => {
        for (const id of frame.ids) hidden.delete(id);
        hide(new Set(hidden));
        if (hidden.size === 0) finish();
      }, START_MS + frame.at),
    );
  }
  if (frames.length === 0) finish();
  return finish;
}
