import "server-only";

import { HttpError } from "./http";

export type RateRule = { limit: number; windowMs: number };

/** Per-user budgets for paid upstream APIs. */
export const RATE_RULES = {
  /** Gate calls: one per utterance or pen pause. */
  mew: { limit: 40, windowMs: 60_000 },
  mewDaily: { limit: 3000, windowMs: 86_400_000 },
  /** Speech-to-text sessions: one per mic start. */
  sttToken: { limit: 10, windowMs: 60_000 },
  sttTokenDaily: { limit: 200, windowMs: 86_400_000 },
} as const satisfies Record<string, RateRule>;

const MAX_TRACKED_KEYS = 50_000;

/**
 * Sliding-window rate limiter held in memory. Correct for a single server instance; when the
 * web app scales out, swap for a shared store behind the same `consume` signature.
 */
export class MemoryRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Records a hit and reports whether it was within the rule. Rejected hits aren't counted. */
  consume(key: string, rule: RateRule): { ok: boolean; retryAfterMs: number } {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < rule.windowMs);
    if (recent.length >= rule.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: rule.windowMs - (now - (recent[0] ?? now)) };
    }
    recent.push(now);
    this.hits.delete(key); // re-insert so Map order tracks recency for eviction
    this.hits.set(key, recent);
    this.evict();
    return { ok: true, retryAfterMs: 0 };
  }

  private evict(): void {
    while (this.hits.size > MAX_TRACKED_KEYS) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) return;
      this.hits.delete(oldest);
    }
  }
}

const limiter = new MemoryRateLimiter();

/** Throws 429 (with Retry-After) when the user is over any of the given rules. */
export function enforceRateLimit(
  userId: string,
  rules: Record<string, RateRule>,
  rateLimiter: MemoryRateLimiter = limiter,
): void {
  for (const [name, rule] of Object.entries(rules)) {
    const { ok, retryAfterMs } = rateLimiter.consume(`${name}:${userId}`, rule);
    if (!ok) {
      throw new HttpError(429, "Too many requests", {
        "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
      });
    }
  }
}
