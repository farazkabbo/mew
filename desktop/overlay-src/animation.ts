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

type Spot = readonly [number, number];

/** neb's pointer flying to what it's talking about (the arc and timing come from Clicky, MIT). */
export type Flight = { from: Spot; control: Spot; to: Spot; durationMs: number };

export type FlightPose = {
  x: number;
  y: number;
  /** The direction of travel, in radians (0 is rightward, as in `atan2`). */
  heading: number;
  /** Size: largest halfway along, for the swoop. */
  size: number;
};

/** The way from the cursor to `to`, staying on the monitor. Null if it's already there. */
export function planFlight(
  from: Spot,
  to: Spot,
  bounds: readonly number[],
  scale: number,
): Flight | null {
  const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (distance < 2 * scale) return null;
  const cssDistance = distance / scale;
  const lift = Math.min(distance * 0.2, 80 * scale);
  // A curve stays within its three points, so a control point on the monitor keeps it all there.
  const top = bounds[1] ?? 0;
  return {
    from,
    to,
    control: [(from[0] + to[0]) / 2, Math.max((from[1] + to[1]) / 2 - lift, top)],
    durationMs: Math.min(Math.max(cssDistance / 0.8, 600), 1400),
  };
}

/** Where the pointer is `elapsedMs` into a flight: eased, on a quadratic curve. */
export function flightAt({ from, control, to, durationMs }: Flight, elapsedMs: number): FlightPose {
  const linear = Math.min(Math.max(elapsedMs / durationMs, 0), 1);
  const t = linear * linear * (3 - 2 * linear);
  const u = 1 - t;
  const along = (i: 0 | 1) => u * u * from[i] + 2 * u * t * control[i] + t * t * to[i];
  const tangent = (i: 0 | 1) => 2 * u * (control[i] - from[i]) + 2 * t * (to[i] - control[i]);
  return {
    x: along(0),
    y: along(1),
    heading: Math.atan2(tangent(1), tangent(0)),
    size: 1 + Math.sin(linear * Math.PI) * 0.3,
  };
}
