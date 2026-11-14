import { describe, expect, it } from "vitest";

import { planCrop } from "./crop";
import { fnv1a, strokeGroupHash } from "./hash";
import { hasRealPressure, outlineToPath, strokePath } from "./outline";
import { strokeThrough } from "./test-helpers";
import {
  keepBelowTop,
  MAX_ZOOM,
  MIN_ZOOM,
  pageToScreen,
  panBy,
  screenToPage,
  zoomAt,
} from "./viewport";

describe("planCrop", () => {
  it("pads the region and upscales small crops up to the max scale", () => {
    const plan = planCrop([100, 100, 50, 20], { padding: 10, maxScale: 3, maxSide: 1024 });

    expect(plan.region).toEqual([90, 90, 70, 40]);
    expect(plan.scale).toBe(3);
    expect([plan.pixelWidth, plan.pixelHeight]).toEqual([210, 120]);
  });

  it("caps the longest side for large crops", () => {
    const plan = planCrop([0, 0, 4000, 100], { padding: 0, maxSide: 1000 });

    expect(plan.pixelWidth).toBe(1000);
    expect(plan.pixelHeight).toBe(25);
  });

  it("never produces an empty image", () => {
    const plan = planCrop([5, 5, 0, 0], { padding: 0 });

    expect(plan.pixelWidth).toBeGreaterThanOrEqual(1);
    expect(plan.pixelHeight).toBeGreaterThanOrEqual(1);
  });
});

describe("hashing", () => {
  it("is deterministic and hex-encoded", () => {
    expect(fnv1a("mew")).toBe(fnv1a("mew"));
    expect(fnv1a("mew")).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a("mew")).not.toBe(fnv1a("mex"));
  });

  it("ignores stroke order but notices moved strokes", () => {
    const a = strokeThrough([
      [0, 0],
      [10, 0],
    ]);
    const b = strokeThrough([
      [0, 9],
      [10, 9],
    ]);
    const moved = { ...a, bbox: [50, 50, 10, 2] as [number, number, number, number] };

    expect(strokeGroupHash([a, b])).toBe(strokeGroupHash([b, a]));
    expect(strokeGroupHash([moved, b])).not.toBe(strokeGroupHash([a, b]));
  });
});

describe("outline", () => {
  it("produces closed SVG path data for a stroke", () => {
    const path = strokePath(
      strokeThrough([
        [0, 0],
        [10, 5],
        [20, 0],
        [30, 8],
      ]),
    );

    expect(path.startsWith("M")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
  });

  it("returns an empty path for degenerate outlines", () => {
    expect(outlineToPath([[1, 1]])).toBe("");
  });

  it("detects real pen pressure", () => {
    expect(hasRealPressure([[0, 0, 0.5, 0]])).toBe(false);
    expect(
      hasRealPressure([
        [0, 0, 0.5, 0],
        [1, 1, 0.73, 8],
      ]),
    ).toBe(true);
  });
});

describe("viewport", () => {
  it("round-trips screen and page coordinates", () => {
    const camera = { x: 100, y: -50, zoom: 2 };
    const page = screenToPage(camera, [40, 60]);

    expect(page).toEqual([120, -20]);
    expect(pageToScreen(camera, page)).toEqual([40, 60]);
  });

  it("keeps the anchor fixed when zooming", () => {
    const camera = { x: 10, y: 20, zoom: 1 };
    const anchor = [300, 200] as const;
    const before = screenToPage(camera, anchor);
    const after = screenToPage(zoomAt(camera, anchor, 1.7), anchor);

    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
  });

  it("clamps zoom", () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, [0, 0], 100).zoom).toBe(MAX_ZOOM);
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, [0, 0], 0.001).zoom).toBe(MIN_ZOOM);
  });

  it("pans opposite to the drag direction in page space, scaled by zoom", () => {
    expect(panBy({ x: 0, y: 0, zoom: 2 }, 20, -10)).toEqual({ x: -10, y: 5, zoom: 2 });
  });

  it("stops at the page's top edge but never at the bottom", () => {
    const top = { x: 0, y: 0, zoom: 1 };
    expect(keepBelowTop(panBy(top, 0, 300))).toEqual(top); // dragging down at the top: no gap
    expect(keepBelowTop(zoomAt(top, [400, 300], 0.5)).y).toBe(0); // zooming out at the top
    const far = keepBelowTop(panBy(top, 0, -1_000_000));
    expect(far.y).toBe(1_000_000); // as far down as you like
    expect(keepBelowTop(far)).toBe(far);
  });
});
