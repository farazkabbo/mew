"use client";

import { LATENCY_STAGE_LABELS, LATENCY_STAGES, LATENCY_TARGETS, LatencyReport } from "@mew/shared";
import { useEffect, useState } from "react";

const seconds = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

/** Median and 95th-percentile time per stage of a tutor turn, against the brief's targets. */
export function LatencyTable() {
  const [report, setReport] = useState<LatencyReport | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/telemetry", { cache: "no-store" })
      .then(async (r) => (r.ok ? LatencyReport.parse(await r.json()) : Promise.reject()))
      .then(
        (next) => !cancelled && setReport(next),
        () => !cancelled && setFailed(true),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return <p className="text-sm text-ink-muted">Couldn&apos;t load the numbers.</p>;
  if (!report) return <p className="text-sm text-ink-muted">Loading…</p>;
  if (report.turns === 0) {
    return (
      <p className="text-sm text-ink-muted" data-testid="latency-empty">
        No tutor turns yet. Ask the tutor something in the notebook.
      </p>
    );
  }
  return (
    <table className="w-full max-w-lg text-sm" data-testid="latency-table">
      <caption className="mb-2 text-left text-ink-muted">
        Last {report.turns} turn{report.turns === 1 ? "" : "s"}, from the end of your question
      </caption>
      <thead>
        <tr className="border-b border-rule text-left text-ink-muted">
          <th className="py-1 font-normal">Stage</th>
          <th className="py-1 text-right font-normal">Typical</th>
          <th className="py-1 text-right font-normal">Slowest 5%</th>
          <th className="py-1 text-right font-normal">Target</th>
        </tr>
      </thead>
      <tbody>
        {LATENCY_STAGES.map((stage) => {
          const stats = report.stages[stage];
          const target = LATENCY_TARGETS[stage];
          if (!stats) return null;
          const slow = target !== undefined && stats.p50 > target;
          return (
            <tr key={stage} className="border-b border-rule/60">
              <td className="py-1.5">{LATENCY_STAGE_LABELS[stage]}</td>
              <td className={`py-1.5 text-right tabular-nums ${slow ? "text-error" : ""}`}>
                {seconds(stats.p50)}
              </td>
              <td className="py-1.5 text-right text-ink-muted tabular-nums">
                {seconds(stats.p95)}
              </td>
              <td className="py-1.5 text-right text-ink-muted tabular-nums">
                {target === undefined ? "" : seconds(target)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
