import { RoughGenerator } from "roughjs/bin/generator.js";
import type { Drawable, Options } from "roughjs/bin/core.js";

/** A polyline in page coordinates. */
export type Path = [number, number][];

const CURVE_STEPS = 8;

/**
 * Hand-drawn shapes from roughjs, returned as pen paths (not SVG or canvas): one wobbly pass per
 * shape, like a single confident pen stroke. Seeded, so a turn always draws the same way.
 */
export class RoughPen {
  private readonly generator = new RoughGenerator();
  private readonly base: Options;

  constructor(seed: number, roughness = 0.9) {
    this.base = {
      seed: Math.max(1, Math.floor(seed) % 2 ** 31),
      roughness,
      bowing: 1,
      disableMultiStroke: true,
      preserveVertices: true,
    };
  }

  line(x1: number, y1: number, x2: number, y2: number): Path[] {
    return toPaths(this.generator.line(x1, y1, x2, y2, this.options()));
  }

  rectangle(x: number, y: number, w: number, h: number): Path[] {
    return toPaths(this.generator.rectangle(x, y, w, h, this.options()));
  }

  ellipse(cx: number, cy: number, w: number, h: number): Path[] {
    return toPaths(this.generator.ellipse(cx, cy, w, h, this.options({ curveStepCount: 12 })));
  }

  polyline(points: Path): Path[] {
    return toPaths(this.generator.linearPath(points, this.options()));
  }

  private options(extra: Options = {}): Options {
    // Each shape gets the next seed, so repeated shapes don't wobble identically.
    this.base.seed = ((this.base.seed ?? 1) * 48271) % 2147483647;
    return { ...this.base, ...extra };
  }
}

/** roughjs drawing ops → polylines (bezier segments sampled into points). */
export function toPaths(drawable: Drawable): Path[] {
  const paths: Path[] = [];
  let current: Path = [];
  for (const set of drawable.sets) {
    if (set.type !== "path") continue;
    for (const { op, data } of set.ops) {
      if (op === "move") {
        if (current.length > 1) paths.push(current);
        current = [[data[0] ?? 0, data[1] ?? 0]];
      } else if (op === "lineTo") {
        current.push([data[0] ?? 0, data[1] ?? 0]);
      } else {
        const start = current.at(-1) ?? [data[4] ?? 0, data[5] ?? 0];
        const [c1x = 0, c1y = 0, c2x = 0, c2y = 0, x = 0, y = 0] = data;
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS;
          const u = 1 - t;
          current.push([
            u * u * u * start[0] + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
            u * u * u * start[1] + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
          ]);
        }
      }
    }
  }
  if (current.length > 1) paths.push(current);
  return paths;
}
