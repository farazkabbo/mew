import { describe, expect, it } from "vitest";

import { percentile, summarizeLatency } from "./telemetry";

describe("latency statistics", () => {
  it("takes percentiles by nearest rank", () => {
    const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(percentile(values, 50)).toBe(500);
    expect(percentile(values, 95)).toBe(1000);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 50)).toBeNaN();
  });

  it("summarises each stage over the turns that reached it", () => {
    const report = summarizeLatency([
      { intent: "answer_question", outcome: "done", gateMs: 200, firstAudioMs: 1400 },
      { intent: "give_hint", outcome: "failed", gateMs: 600 },
    ]);
    expect(report.turns).toBe(2);
    expect(report.stages.gateMs).toEqual({ n: 2, p50: 200, p95: 600 });
    expect(report.stages.firstAudioMs).toEqual({ n: 1, p50: 1400, p95: 1400 });
    expect(report.stages.inkStartMs).toBeNull();
  });
});
