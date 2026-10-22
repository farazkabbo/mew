import "server-only";

import { type LatencyReport, type LatencySample, summarizeLatency } from "@mew/shared";

/** Recent turns kept per user, and users tracked (the least recently active are dropped). */
const PER_USER = 200;
const MAX_USERS = 5_000;

/**
 * Turn latencies, in memory (one server instance, like the rate limiter): each student can see
 * their own recent numbers, and every sample is logged as one JSON line for the host's log
 * search. Samples carry timings only, and the log line no user id.
 */
export class LatencyLog {
  private readonly byUser = new Map<string, LatencySample[]>();

  constructor(private readonly log: (line: string) => void = (line) => console.info(line)) {}

  record(userId: string, samples: readonly LatencySample[]): void {
    const recent = [...(this.byUser.get(userId) ?? []), ...samples].slice(-PER_USER);
    this.byUser.delete(userId); // re-insert so Map order tracks recency
    this.byUser.set(userId, recent);
    while (this.byUser.size > MAX_USERS) {
      const oldest = this.byUser.keys().next().value;
      if (oldest === undefined) break;
      this.byUser.delete(oldest);
    }
    for (const sample of samples) this.log(`[latency] ${JSON.stringify(sample)}`);
  }

  report(userId: string): LatencyReport {
    return summarizeLatency(this.byUser.get(userId) ?? []);
  }
}

export const latencyLog = new LatencyLog();
