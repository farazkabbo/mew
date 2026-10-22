import "server-only";

import { HttpError } from "./http-error";

/** `limit` units per sliding `windowMs`. A unit is a request unless a cost is given. */
export type RateRule = { limit: number; windowMs: number };

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Per-user budgets for paid upstream APIs. */
export const RATE_RULES = {
  /** Gate calls: one per utterance or pen pause. */
  mew: { limit: 40, windowMs: MINUTE },
  mewDaily: { limit: 3000, windowMs: DAY },
  /** Speech-to-text sessions: one per mic start. */
  sttToken: { limit: 10, windowMs: MINUTE },
  sttTokenDaily: { limit: 200, windowMs: DAY },
  /** Tutor turns (the expensive model). */
  tutor: { limit: 15, windowMs: MINUTE },
  tutorDaily: { limit: 400, windowMs: DAY },
  /** Handwriting recognition of single lines. */
  recognize: { limit: 30, windowMs: MINUTE },
  recognizeDaily: { limit: 1500, windowMs: DAY },
  /** Building a course from a PDF (parsing, embeddings, a model call). */
  courseCreate: { limit: 6, windowMs: 60 * MINUTE },
  courseCreateDaily: { limit: 20, windowMs: DAY },
  /** Reading and editing courses. */
  courseRead: { limit: 120, windowMs: MINUTE },
  /** Lessons (a model call the first time each is opened) and retrieval for the tutor. */
  lesson: { limit: 20, windowMs: MINUTE },
  lessonDaily: { limit: 300, windowMs: DAY },
  retrieve: { limit: 60, windowMs: MINUTE },
  /** Recording answers (practice and quiz) for the learner model. */
  attempt: { limit: 60, windowMs: MINUTE },
  attemptDaily: { limit: 3000, windowMs: DAY },
  /** Listing, labelling and exporting kept gate decisions (Teach Mew). */
  mewEvents: { limit: 120, windowMs: MINUTE },
  /** Reading and changing settings (changes are coalesced by the client). */
  settings: { limit: 120, windowMs: MINUTE },
  /** Latency reports (batched by the client) and reading them back. */
  telemetry: { limit: 30, windowMs: MINUTE },
  telemetryRead: { limit: 60, windowMs: MINUTE },
  /** Grading a quiz answer (a model call with an image). */
  quizGrade: { limit: 15, windowMs: MINUTE },
  quizGradeDaily: { limit: 400, windowMs: DAY },
  /** Work checks (SymPy on the API service: CPU, not money, but still bounded). */
  check: { limit: 30, windowMs: MINUTE },
  checkDaily: { limit: 2000, windowMs: DAY },
  /** Text-to-speech, measured in characters (that's how it is billed). */
  ttsCharsPerMinute: { limit: 3000, windowMs: MINUTE },
  ttsCharsDaily: { limit: 40_000, windowMs: DAY },
} as const satisfies Record<string, RateRule>;

const MAX_TRACKED_KEYS = 50_000;

type Hit = { at: number; cost: number };

/**
 * Sliding-window rate limiter held in memory. Correct for a single server instance; when the
 * web app scales out, swap for a shared store behind the same `consume` signature.
 */
export class MemoryRateLimiter {
  private readonly hits = new Map<string, Hit[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Records a hit of `cost` units and reports whether it fit. Rejected hits aren't counted. */
  consume(key: string, rule: RateRule, cost = 1): { ok: boolean; retryAfterMs: number } {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => now - h.at < rule.windowMs);
    const used = recent.reduce((sum, h) => sum + h.cost, 0);
    if (used + cost > rule.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: rule.windowMs - (now - (recent[0]?.at ?? now)) };
    }
    recent.push({ at: now, cost });
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
  { cost = 1, rateLimiter = limiter }: { cost?: number; rateLimiter?: MemoryRateLimiter } = {},
): void {
  for (const [name, rule] of Object.entries(rules)) {
    const { ok, retryAfterMs } = rateLimiter.consume(`${name}:${userId}`, rule, cost);
    if (!ok) {
      throw new HttpError(429, "Too many requests", {
        "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
      });
    }
  }
}
