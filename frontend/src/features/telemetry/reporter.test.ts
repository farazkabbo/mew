import type { TelemetryBatch } from "@mew/shared";
import { describe, expect, it } from "vitest";

import type { Turn } from "../tutor/store";
import { LatencyReporter, toSample } from "./reporter";

function turn(id: number, outcome: Turn["outcome"], timings: Turn["timings"] = {}): Turn {
  return {
    id,
    at: 0,
    intent: "answer_question",
    utterance: "why does the force cancel out?",
    speech: "Think about the directions.",
    actions: [],
    timings,
    outcome,
  };
}

describe("LatencyReporter", () => {
  it("reports each finished turn once, with timings only", () => {
    const sent: TelemetryBatch[] = [];
    const reporter = new LatencyReporter((batch) => sent.push(batch));

    reporter.observe([turn(1, "pending", { gateMs: 300 })]);
    reporter.observe([turn(1, "done", { gateMs: 300.4, firstAudioMs: 1200, totalMs: 2100 })]);
    reporter.observe([turn(1, "done", { gateMs: 300 })]); // the same turn again
    reporter.flush();

    expect(sent).toEqual([
      {
        turns: [
          {
            intent: "answer_question",
            outcome: "done",
            gateMs: 300,
            firstAudioMs: 1200,
            totalMs: 2100,
          },
        ],
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain("force");
  });

  it("clamps impossible values and sends batches of at most 20", () => {
    expect(toSample(turn(1, "failed", { gateMs: -5, totalMs: 9e9 }))).toEqual({
      intent: "answer_question",
      outcome: "failed",
      gateMs: 0,
      totalMs: 300_000,
    });
    const sent: TelemetryBatch[] = [];
    const reporter = new LatencyReporter((batch) => sent.push(batch));
    for (let i = 0; i < 9; i++) reporter.observe([turn(i, "done")]);
    expect(sent).toEqual([]); // waits for a batch of 10 (or the timer)
    reporter.observe([turn(9, "interrupted")]);
    expect(sent[0]?.turns).toHaveLength(10);
  });
});
