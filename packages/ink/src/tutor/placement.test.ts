import type { BBox } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { OccupancyGrid, overlapsAny, placeBox, type PlacementContext } from "./placement";

const VIEWPORT: BBox = [0, 0, 1000, 800];

function context(obstacles: BBox[], line?: BBox): PlacementContext {
  const grid = new OccupancyGrid([-500, -500, 2500, 2500], 5);
  for (const o of obstacles) grid.mark(o);
  return { grid, line, viewport: VIEWPORT, gap: 10 };
}

describe("OccupancyGrid", () => {
  it("answers whether rectangles are free", () => {
    const grid = new OccupancyGrid([0, 0, 100, 100], 10);
    grid.mark([20, 20, 10, 10]);
    expect(grid.isFree([0, 0, 15, 15])).toBe(true);
    expect(grid.isFree([25, 25, 30, 30])).toBe(false);
    expect(grid.isFree([31, 0, 50, 100])).toBe(true);
    // Outside the region nothing was marked.
    expect(grid.isFree([500, 500, 10, 10])).toBe(true);
  });

  it("is conservative: partial cell overlap counts as occupied", () => {
    const grid = new OccupancyGrid([0, 0, 100, 100], 10);
    grid.mark([19, 19, 2, 2]); // touches cells (1,1) to (2,2)
    expect(grid.isFree([20.5, 20.5, 1, 1])).toBe(false);
  });

  it("coarsens on huge regions to stay bounded", () => {
    const grid = new OccupancyGrid([0, 0, 1e6, 1e6], 5);
    expect(grid.cell).toBeGreaterThan(5);
  });
});

describe("placeBox", () => {
  const line: BBox = [100, 100, 200, 30];

  it("puts active_line content to the right of the line, vertically centred", () => {
    const box = placeBox([80, 20], { near: "active_line" }, context([line], line));
    expect(box[0]).toBeGreaterThan(300);
    expect(box[1] + box[3] / 2).toBeCloseTo(115);
  });

  it("puts below_active_line content under the line, left-aligned", () => {
    const box = placeBox([80, 20], { near: "below_active_line" }, context([line], line));
    expect(box[0]).toBe(100);
    expect(box[1]).toBeGreaterThan(130);
  });

  it("moves past whatever is already below the line", () => {
    const busy: BBox = [100, 135, 300, 60];
    const box = placeBox([80, 20], { near: "below_active_line" }, context([line, busy], line));
    expect(overlapsAny(box, [busy])).toBe(false);
    expect(overlapsAny(box, [line])).toBe(false);
  });

  it("never overlaps obstacles, even on a crowded page", () => {
    const obstacles: BBox[] = [];
    for (let y = 0; y < 700; y += 40) obstacles.push([0, y, 900, 28]); // ruled with writing
    for (const near of [
      "active_line",
      "below_active_line",
      "margin_right",
      "free_space",
    ] as const) {
      const box = placeBox([120, 30], { near }, context(obstacles, [0, 160, 900, 28]));
      expect(overlapsAny(box, obstacles)).toBe(false);
    }
  });

  it("prefers spots on screen", () => {
    const box = placeBox([80, 20], { near: "active_line" }, context([line], line));
    expect(box[0] + box[2]).toBeLessThanOrEqual(1000);
    expect(box[1] + box[3]).toBeLessThanOrEqual(800);
  });

  it("works without a line (empty page), starting near the top-left of the view", () => {
    const box = placeBox([80, 20], { near: "free_space" }, context([]));
    expect(box[0]).toBeLessThan(100);
    expect(box[1]).toBeLessThan(100);
  });
});
