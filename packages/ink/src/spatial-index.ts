import type { BBox } from "@mew/shared";

/** Items spanning more cells than this live in a side list that every query checks. */
const MAX_CELLS_PER_ITEM = 1024;

/**
 * Uniform-grid spatial index for hit testing and viewport culling. Queries return candidates
 * whose boxes share a cell with the query box; callers do exact tests on that small set.
 */
export class SpatialIndex {
  private readonly cells = new Map<string, Set<string>>();
  private readonly itemCells = new Map<string, string[]>();
  private readonly oversized = new Set<string>();

  constructor(private readonly cellSize = 256) {}

  get size(): number {
    return this.itemCells.size + this.oversized.size;
  }

  insert(id: string, bbox: BBox): void {
    this.remove(id);
    const keys = this.keysFor(bbox);
    if (keys === null) {
      this.oversized.add(id);
      return;
    }
    for (const key of keys) {
      let cell = this.cells.get(key);
      if (!cell) {
        cell = new Set();
        this.cells.set(key, cell);
      }
      cell.add(id);
    }
    this.itemCells.set(id, keys);
  }

  remove(id: string): void {
    if (this.oversized.delete(id)) return;
    const keys = this.itemCells.get(id);
    if (!keys) return;
    for (const key of keys) {
      const cell = this.cells.get(key);
      cell?.delete(id);
      if (cell?.size === 0) this.cells.delete(key);
    }
    this.itemCells.delete(id);
  }

  query(bbox: BBox): Set<string> {
    const result = new Set(this.oversized);
    const keys = this.keysFor(bbox);
    if (keys === null) {
      for (const id of this.itemCells.keys()) result.add(id);
      return result;
    }
    for (const key of keys) {
      for (const id of this.cells.get(key) ?? []) result.add(id);
    }
    return result;
  }

  clear(): void {
    this.cells.clear();
    this.itemCells.clear();
    this.oversized.clear();
  }

  /** Cell keys covered by a box, or null when it spans too many cells to enumerate. */
  private keysFor([x, y, w, h]: BBox): string[] | null {
    const x0 = Math.floor(x / this.cellSize);
    const y0 = Math.floor(y / this.cellSize);
    const x1 = Math.floor((x + w) / this.cellSize);
    const y1 = Math.floor((y + h) / this.cellSize);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_ITEM) return null;
    const keys: string[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) keys.push(`${cx},${cy}`);
    }
    return keys;
  }
}
