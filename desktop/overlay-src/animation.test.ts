import type { Point } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { flightAt, planFlight, schedule, visiblePoints } from "./animation";

const stroke = (ms: number): { points: Point[] } => ({
  points: [
    [0, 0, 0.5, 0],
    [1, 1, 0.5, ms / 2],
    [2, 2, 0.5, ms],
  ],
});

describe("the pointer's flight", () => {
  const MONITOR = [0, 0, 1920, 1080];

  it("arcs upward from the cursor and lands on the target, facing the way it went", () => {
    const flight = planFlight([100, 900], [900, 900], MONITOR, 1);
    expect(flight?.durationMs).toBe(1000);
    if (!flight) return;
    expect(flightAt(flight, 0)).toMatchObject({ x: 100, y: 900, size: 1 });
    const middle = flightAt(flight, 500);
    expect(middle.x).toBeCloseTo(500);
    expect(middle.y).toBeLessThan(900);
    expect(middle.size).toBeCloseTo(1.3);
    const landed = flightAt(flight, 5000);
    expect([landed.x, landed.y]).toEqual([900, 900]);
    expect(landed.heading).toBeGreaterThan(0); // coming down to the right
    expect(landed.heading).toBeLessThan(Math.PI / 2);
  });

  it("takes longer for longer trips, within limits, at any display scale", () => {
    expect(planFlight([0, 0], [50, 0], MONITOR, 1)?.durationMs).toBe(600);
    expect(planFlight([0, 500], [1900, 500], MONITOR, 1)?.durationMs).toBe(1400);
    expect(planFlight([0, 500], [800, 500], MONITOR, 2)?.durationMs).toBe(600);
  });

  it("stays on the monitor along its top edge", () => {
    const flight = planFlight([100, 10], [900, 10], MONITOR, 1);
    expect(flight?.control[1]).toBe(0);
  });

  it("doesn't fly when the cursor is already there", () => {
    expect(planFlight([500, 500], [501, 500], MONITOR, 1)).toBeNull();
  });
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
