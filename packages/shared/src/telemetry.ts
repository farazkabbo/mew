import { z } from "zod";

import { MewLabel } from "./mew";

/**
 * Latency telemetry (M9, brief §14: log latency for each stage). Each tutor turn reports how
 * long each stage took from its trigger. Timings only: never what was said or written.
 */

export const LATENCY_STAGES = [
  "gateMs",
  "tutorSpeechMs",
  "firstAudioMs",
  "inkStartMs",
  "totalMs",
] as const;
export type LatencyStage = (typeof LATENCY_STAGES)[number];

export const LATENCY_STAGE_LABELS: Record<LatencyStage, string> = {
  gateMs: "Mew decides",
  tutorSpeechMs: "Reply ready",
  firstAudioMs: "First audio",
  inkStartMs: "Ink starts",
  totalMs: "Whole turn",
};

/** Brief §3: a gate decision under 400 ms (v1), first audio within ~1.5 s. */
export const LATENCY_TARGETS: Partial<Record<LatencyStage, number>> = {
  gateMs: 400,
  firstAudioMs: 1500,
};

const Ms = z.number().int().min(0).max(300_000);

export const LatencySample = z
  .object({
    intent: MewLabel.exclude(["ignore"]),
    outcome: z.enum(["done", "interrupted", "failed"]),
    gateMs: Ms.optional(),
    tutorSpeechMs: Ms.optional(),
    firstAudioMs: Ms.optional(),
    inkStartMs: Ms.optional(),
    totalMs: Ms.optional(),
  })
  .strict();
export type LatencySample = z.infer<typeof LatencySample>;

export const TelemetryBatch = z.object({ turns: z.array(LatencySample).min(1).max(20) }).strict();
export type TelemetryBatch = z.infer<typeof TelemetryBatch>;

export const StageStats = z.object({ n: z.number().int(), p50: z.number(), p95: z.number() });
export type StageStats = z.infer<typeof StageStats>;

export const LatencyReport = z.object({
  turns: z.number().int(),
  stages: z.record(z.enum(LATENCY_STAGES), StageStats.nullable()),
});
export type LatencyReport = z.infer<typeof LatencyReport>;

/** The p-th percentile (0–100) by nearest rank; NaN for no values. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? Number.NaN;
}

export function summarizeLatency(samples: readonly LatencySample[]): LatencyReport {
  const stages = Object.fromEntries(
    LATENCY_STAGES.map((stage) => {
      const values = samples.map((s) => s[stage]).filter((v): v is number => v !== undefined);
      return [
        stage,
        values.length
          ? { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95) }
          : null,
      ];
    }),
  ) as LatencyReport["stages"];
  return { turns: samples.length, stages };
}
