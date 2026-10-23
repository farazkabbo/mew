import type { Point } from "@mew/shared";

/**
 * Timing for drawing ink stroke by stroke (brief §10: strokes animate in). Each point's `t` is
 * milliseconds since its stroke began, at a natural writing speed; a long answer is sped up so
 * the whole drawing takes at most `maxTotalMs`.
 */
export type Schedule = {
  /** When each stroke starts, in ms from the start of the drawing. */
  starts: number[];
  /** Playback speed (1 = as written; > 1 = faster). */
  speed: number;
  totalMs: number;
};

const GAP_MS = 40;

export function schedule(
  strokes: readonly { points: readonly Point[] }[],
  maxTotalMs = 1500,
): Schedule {
  const durations = strokes.map((s) => s.points.at(-1)?.[3] ?? 0);
  const natural = durations.reduce((sum, d) => sum + d + GAP_MS, 0);
  const speed = natural > maxTotalMs ? natural / maxTotalMs : 1;
  const starts: number[] = [];
  let at = 0;
  for (const duration of durations) {
    starts.push(at);
    at += (duration + GAP_MS) / speed;
  }
  return { starts, speed, totalMs: at };
}

/** How many of a stroke's points are drawn `elapsedMs` into the drawing. */
export function visiblePoints(
  points: readonly Point[],
  start: number,
  speed: number,
  elapsedMs: number,
): number {
  const local = (elapsedMs - start) * speed;
  if (local < 0) return 0;
  let n = 0;
  while (n < points.length && (points[n]?.[3] ?? 0) <= local) n++;
  return Math.max(n, 1);
}
