import type { BBox, Stroke } from "@mew/shared";

import { inflateBBox, type Vec } from "./geometry";
import { eraserHitsStroke } from "./hit-test";
import type { Command } from "./history";
import { SpatialIndex } from "./spatial-index";

/**
 * The strokes on one page, indexed for spatial queries.
 *
 * Invariant: a stroke's `bbox` covers its rendered extent (points ± width / 2); see `strokeBBox`.
 */
export class PageDocument {
  private readonly strokes = new Map<string, Stroke>();
  private readonly index = new SpatialIndex();
  private ordered: Stroke[] | null = null;

  constructor(strokes: Iterable<Stroke> = []) {
    this.add([...strokes]);
  }

  get size(): number {
    return this.strokes.size;
  }

  get(id: string): Stroke | undefined {
    return this.strokes.get(id);
  }

  /** All strokes in drawing order (oldest first), including restored ones. */
  all(): readonly Stroke[] {
    this.ordered ??= [...this.strokes.values()].sort(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
    );
    return this.ordered;
  }

  add(strokes: readonly Stroke[]): void {
    for (const stroke of strokes) {
      this.strokes.set(stroke.id, stroke);
      this.index.insert(stroke.id, stroke.bbox);
    }
    if (strokes.length > 0) this.ordered = null;
  }

  remove(ids: Iterable<string>): Stroke[] {
    const removed: Stroke[] = [];
    for (const id of ids) {
      const stroke = this.strokes.get(id);
      if (!stroke) continue;
      this.strokes.delete(id);
      this.index.remove(id);
      removed.push(stroke);
    }
    if (removed.length > 0) this.ordered = null;
    return removed;
  }

  apply(command: Command): void {
    if (command.kind === "add") this.add(command.strokes);
    else this.remove(command.strokes.map((s) => s.id));
  }

  /** Strokes whose boxes intersect the region, in drawing order. */
  inRegion(region: BBox): Stroke[] {
    const ids = this.index.query(region);
    return this.all().filter((s) => ids.has(s.id));
  }

  /** Strokes touched by an eraser of `radius` sweeping from `from` to `to`. */
  hitByEraser(from: Vec, to: Vec, radius: number): Stroke[] {
    const sweep = inflateBBox(
      [
        Math.min(from[0], to[0]),
        Math.min(from[1], to[1]),
        Math.abs(to[0] - from[0]),
        Math.abs(to[1] - from[1]),
      ],
      radius,
    );
    const hits: Stroke[] = [];
    for (const id of this.index.query(sweep)) {
      const stroke = this.strokes.get(id);
      if (stroke && eraserHitsStroke(stroke, from, to, radius)) hits.push(stroke);
    }
    return hits;
  }
}
