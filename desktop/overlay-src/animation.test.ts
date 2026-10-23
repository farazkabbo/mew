import type { Point } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { schedule, visiblePoints } from "./animation";

const stroke = (ms: number): { points: Point[] } => ({
  points: [
    [0, 0, 0.5, 0],
    [1, 1, 0.5, ms / 2],
    [2, 2, 0.5, ms],
  ],
});

describe("ink animation", () => {
  it("plays short drawings as written, one stroke after another", () => {
    const plan = schedule([stroke(100), stroke(200)]);
    expect(plan.speed).toBe(1);
    expect(plan.starts).toEqual([0, 140]);
    expect(plan.totalMs).toBe(380);
  });

  it("speeds long drawings up to fit the time allowed", () => {
    const plan = schedule(
      Array.from({ length: 30 }, () => stroke(200)),
      1500,
    );
    expect(plan.totalMs).toBeCloseTo(1500);
    expect(plan.speed).toBeGreaterThan(4);
  });

  it("reveals a stroke's points as time passes", () => {
    const { points } = stroke(100);
    expect(visiblePoints(points, 50, 1, 10)).toBe(0);
    expect(visiblePoints(points, 0, 1, 0)).toBe(1);
    expect(visiblePoints(points, 0, 1, 60)).toBe(2);
    expect(visiblePoints(points, 0, 1, 1000)).toBe(3);
    expect(visiblePoints(points, 0, 2, 50)).toBe(3);
  });
});
