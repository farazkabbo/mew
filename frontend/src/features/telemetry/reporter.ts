import { LATENCY_STAGES, type LatencySample, type TelemetryBatch } from "@mew/shared";

import { type Turn, useTutor } from "../tutor/store";

const BATCH = 10;
const FLUSH_MS = 30_000;

type Send = (batch: TelemetryBatch) => void;

/** Collects each finished turn's timings once, and sends them in batches. */
export class LatencyReporter {
  private queue: LatencySample[] = [];
  private seen = new Set<number>();

  constructor(private readonly send: Send) {}

  observe(turns: readonly Turn[]): void {
    for (const turn of turns) {
      if (turn.outcome === "pending" || this.seen.has(turn.id)) continue;
      this.seen.add(turn.id);
      this.queue.push(toSample(turn));
    }
    // Only turns still in the store can come back; forget the rest.
    const ids = new Set(turns.map((t) => t.id));
    for (const id of this.seen) if (!ids.has(id)) this.seen.delete(id);
    if (this.queue.length >= BATCH) this.flush();
  }

  flush(): void {
    while (this.queue.length > 0) this.send({ turns: this.queue.splice(0, 20) });
  }
}

export function toSample(turn: Turn): LatencySample {
  const sample: LatencySample = {
    intent: turn.intent,
    outcome: turn.outcome === "pending" ? "failed" : turn.outcome,
  };
  for (const stage of LATENCY_STAGES) {
    const value = turn.timings[stage];
    if (typeof value === "number" && Number.isFinite(value)) {
      sample[stage] = Math.min(300_000, Math.max(0, Math.round(value)));
    }
  }
  return sample;
}

function send(batch: TelemetryBatch): void {
  // keepalive lets the request outlive the page (a JSON beacon isn't reliable in Chromium).
  void fetch("/api/telemetry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
    keepalive: true,
  }).catch(() => undefined); // telemetry never gets in the way
}

/** Reports turn latencies while the notebook is open. Returns a stop function. */
export function startLatencyReporting(): () => void {
  const reporter = new LatencyReporter(send);
  const unsubscribe = useTutor.subscribe((state) => reporter.observe(state.turns));
  const timer = window.setInterval(() => reporter.flush(), FLUSH_MS);
  const onHide = () => {
    if (document.visibilityState === "hidden") reporter.flush();
  };
  document.addEventListener("visibilitychange", onHide);
  return () => {
    unsubscribe();
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onHide);
    reporter.flush();
  };
}
