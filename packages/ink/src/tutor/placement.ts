import type { Anchor, BBox } from "@mew/shared";

import { unionBBox } from "../geometry";

/** Above this many cells the grid gets coarser, so a huge sparse page stays cheap. */
const MAX_CELLS = 250_000;

/**
 * Occupied/free cells over a region, with a summed-area table so "is this rectangle free?" is
 * O(1). Cells are marked conservatively (any overlap counts), so a free answer is always safe.
 * Space outside the region counts as free: callers include all content in the region.
 */
export class OccupancyGrid {
  readonly cell: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly occupied: Uint8Array;
  private sums: Int32Array | null = null;

  constructor(
    readonly region: BBox,
    cell: number,
  ) {
    const area = Math.max(1, region[2] * region[3]);
    this.cell = Math.max(cell, Math.sqrt(area / MAX_CELLS));
    this.cols = Math.max(1, Math.ceil(region[2] / this.cell));
    this.rows = Math.max(1, Math.ceil(region[3] / this.cell));
    this.occupied = new Uint8Array(this.cols * this.rows);
  }

  mark(box: BBox): void {
    const range = this.range(box);
    if (!range) return;
    const [c0, r0, c1, r1] = range;
    for (let r = r0; r <= r1; r++)
      this.occupied.fill(1, r * this.cols + c0, r * this.cols + c1 + 1);
    this.sums = null;
  }

  isFree(box: BBox): boolean {
    const range = this.range(box);
    if (!range) return true;
    const [c0, r0, c1, r1] = range;
    const sums = this.table();
    const w = this.cols + 1;
    const at = (c: number, r: number) => sums[r * w + c] ?? 0;
    return at(c1 + 1, r1 + 1) - at(c0, r1 + 1) - at(c1 + 1, r0) + at(c0, r0) === 0;
  }

  /** Cell range [c0, r0, c1, r1] covered by a box, clipped to the grid; null if outside. */
  private range([x, y, w, h]: BBox): [number, number, number, number] | null {
    const [rx, ry] = this.region;
    const c0 = Math.max(0, Math.floor((x - rx) / this.cell));
    const r0 = Math.max(0, Math.floor((y - ry) / this.cell));
    const c1 = Math.min(this.cols - 1, Math.ceil((x + w - rx) / this.cell) - 1);
    const r1 = Math.min(this.rows - 1, Math.ceil((y + h - ry) / this.cell) - 1);
    if (c0 > c1 || r0 > r1) return null;
    return [c0, r0, c1, r1];
  }

  private table(): Int32Array {
    if (this.sums) return this.sums;
    const w = this.cols + 1;
    const sums = new Int32Array(w * (this.rows + 1));
    for (let r = 0; r < this.rows; r++) {
      let row = 0;
      for (let c = 0; c < this.cols; c++) {
        row += this.occupied[r * this.cols + c] ?? 0;
        sums[(r + 1) * w + c + 1] = (sums[r * w + c + 1] ?? 0) + row;
      }
    }
    this.sums = sums;
    return sums;
  }
}

export type PlacementContext = {
  grid: OccupancyGrid;
  /** The line the content relates to (usually the one being written). */
  line?: BBox | undefined;
  /** What's on screen: placements stay inside it when possible. */
  viewport: BBox;
  /** Extent of everything on the page (for the always-free fallback below it). */
  content?: BBox | undefined;
  /** Breathing room around content, in page units. */
  gap: number;
};

/**
 * Finds a free spot for a box of `size` according to the anchor. Candidates are tried in order of
 * preference, first on screen, then anywhere; the final fallback (below all content) is always
 * free. Returns the box's page rectangle.
 */
export function placeBox(
  size: readonly [number, number],
  anchor: Anchor,
  ctx: PlacementContext,
): BBox {
  const [w, h] = size;
  const fits = (b: BBox, onScreen: boolean) =>
    ctx.grid.isFree(b) && (!onScreen || contains(ctx.viewport, b));
  const all = [...candidates(size, anchor, ctx)];
  for (const onScreen of [true, false]) {
    for (const [x, y] of all) {
      const box: BBox = [x, y, w, h];
      if (fits(box, onScreen)) return box;
    }
  }
  const content = ctx.content ?? ctx.line ?? ctx.viewport;
  const left = ctx.line?.[0] ?? ctx.viewport[0] + ctx.gap;
  return [left, content[1] + content[3] + 2 * ctx.gap, w, h];
}

function* candidates(
  [w, h]: readonly [number, number],
  anchor: Anchor,
  { line, viewport, gap, grid }: PlacementContext,
): Generator<[number, number]> {
  const ref: BBox = line ?? [viewport[0] + 2 * gap, viewport[1] + 2 * gap, 0, 0];
  const [lx, ly, lw, lh] = ref;
  const centredY = ly + lh / 2 - h / 2;
  const below = ly + lh + gap;

  if (anchor.near === "active_line" && line) {
    for (let k = 0; k <= 30; k++) yield [lx + lw + 2 * gap + k * gap, centredY];
  }
  if (anchor.near === "margin_right" && line) {
    // Right of everything near this line's band, so it reads as a margin note.
    const band: BBox = [lx, ly - 2 * lh, Number.MAX_SAFE_INTEGER / 4, 5 * lh];
    const right = Math.max(lx + lw, rightmostOccupied(grid, band) ?? lx + lw);
    for (let k = 0; k <= 30; k++) yield [right + 3 * gap, centredY + k * (gap / 2)];
  }
  if (anchor.near === "free_space") {
    yield* rings([lx + lw / 2 - w / 2, ly + lh / 2 - h / 2], gap, 40);
  }
  // below_active_line, and the fallback for every other anchor: under the line, then further down
  // and to the right.
  for (let k = 0; k <= 60; k++) yield [lx, below + (k * gap) / 2];
  for (let k = 1; k <= 20; k++) {
    for (let j = 0; j <= 20; j++) yield [lx + k * 2 * gap, below + j * gap];
  }
  yield* rings([lx, below], gap, 40);
}

/** Positions on growing square rings around a start point, nearest ring first. */
function* rings(
  [x0, y0]: readonly [number, number],
  step: number,
  count: number,
): Generator<[number, number]> {
  yield [x0, y0];
  for (let r = 1; r <= count; r++) {
    const d = r * step;
    for (let k = -r; k <= r; k++) {
      yield [x0 + k * step, y0 + d];
      yield [x0 + d, y0 + k * step];
      yield [x0 + k * step, y0 - d];
      yield [x0 - d, y0 + k * step];
    }
  }
}

/** Right edge of occupied cells within `band`, scanning the grid; undefined if none. */
function rightmostOccupied(grid: OccupancyGrid, band: BBox): number | undefined {
  const [, y, , h] = band;
  const start = Math.max(band[0], grid.region[0]);
  const end = grid.region[0] + grid.region[2];
  let found: number | undefined;
  for (let x = start; x < end; x += grid.cell) {
    if (!grid.isFree([x, y, grid.cell / 2, h])) found = x + grid.cell;
  }
  return found;
}

function contains(outer: BBox, inner: BBox): boolean {
  return (
    inner[0] >= outer[0] &&
    inner[1] >= outer[1] &&
    inner[0] + inner[2] <= outer[0] + outer[2] &&
    inner[1] + inner[3] <= outer[1] + outer[3]
  );
}

/** Whether `box` overlaps the interior of any of `obstacles` (sharing an edge doesn't count). */
export function overlapsAny(box: BBox, obstacles: readonly BBox[]): boolean {
  return obstacles.some(
    (o) =>
      box[0] < o[0] + o[2] &&
      o[0] < box[0] + box[2] &&
      box[1] < o[1] + o[3] &&
      o[1] < box[1] + box[3],
  );
}

/** Grid region covering the viewport and all content, with room to search around it. */
export function searchRegion(viewport: BBox, content: BBox | undefined, margin: number): BBox {
  const base = content ? unionBBox(viewport, content) : viewport;
  return [base[0] - margin, base[1] - margin, base[2] + 2 * margin, base[3] + 2 * margin];
}
