import "server-only";

import { HttpError } from "./http-error";

/** `limit` units per sliding `windowMs`. A unit is a request unless a cost is given. */
export type RateRule = { limit: number; windowMs: number };

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Notes checks a student may run a day (brief §11: configurable): NOTES_CHECKS_PER_DAY. */
const NOTES_CHECKS_PER_DAY = Math.min(
  Math.max(Number.parseInt(process.env.NOTES_CHECKS_PER_DAY ?? "", 10) || 60, 1),
  1000,
);

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
  /**
   * Show-then-You (K6): a worked solution is up to 4 model calls (two tries, each with a rubric
   * check for subjects SymPy can't verify) and 4 SymPy checks.
   */
  solution: { limit: 6, windowMs: MINUTE },
  solutionDaily: { limit: 120, windowMs: DAY },
  /** K8: answering a moment's check (a grader call when it's words, SymPy when it's maths). */
  momentAnswer: { limit: 20, windowMs: MINUTE },
  momentAnswerDaily: { limit: 300, windowMs: DAY },
  /** K8: reading checks and a moment's voice (no model). */
  momentRead: { limit: 120, windowMs: MINUTE },
  /** K8: a moment's voice, uploaded a step at a time after it was played. */
  momentAudio: { limit: 30, windowMs: MINUTE },
  momentAudioDaily: { limit: 600, windowMs: DAY },
  /** Handwriting recognition of single lines. */
  recognize: { limit: 30, windowMs: MINUTE },
  recognizeDaily: { limit: 1500, windowMs: DAY },
  /**
   * Notes Check backfill: lines that were never recognised, up to 8 per call. The client sends
   * one batch every 15 s at most; the daily budget is counted in lines, not calls.
   */
  recognizeBatch: { limit: 6, windowMs: MINUTE },
  recognizeBatchLinesDaily: { limit: 2000, windowMs: DAY },
  /** Notes Check: syncing a page's line text (an embedding call for the lines that changed). */
  notesSync: { limit: 40, windowMs: MINUTE },
  notesSyncDaily: { limit: 4000, windowMs: DAY },
  /**
   * The notebook tree (K1): titles and places only (a database call, no model), synced soon
   * after edits and on focus. Room for a student reorganising a lot at once.
   */
  notebookTree: { limit: 120, windowMs: MINUTE },
  /**
   * Screen Coach's destinations (K3): resolving "save it to Physics chapter 5" (a database read;
   * the gate model only for descriptions), the picker's places, and moving a saved moment.
   */
  destinations: { limit: 30, windowMs: MINUTE },
  /** Notebook PDFs (K4): imports are big (up to 100 MB); pages are drawn as they're viewed. */
  pdfImport: { limit: 6, windowMs: MINUTE },
  pdfImportDaily: { limit: 40, windowMs: DAY },
  pdfPage: { limit: 240, windowMs: MINUTE },
  pdfPageDaily: { limit: 8000, windowMs: DAY },
  destinationsDaily: { limit: 800, windowMs: DAY },
  notebookTreeDaily: { limit: 5000, windowMs: DAY },
  /**
   * Notes checks: one comparison call and up to five verifier calls each (brief §11), so the
   * daily budget is what really caps the cost.
   */
  notesCheck: { limit: 6, windowMs: MINUTE },
  notesCheckDaily: { limit: NOTES_CHECKS_PER_DAY, windowMs: DAY },
  notesCheckMonthly: { limit: NOTES_CHECKS_PER_DAY * 10, windowMs: 30 * DAY },
  /** Resolving a finding (a model call each: resolve, explain or a gap's heading). */
  notesResolve: { limit: 20, windowMs: MINUTE },
  notesResolveDaily: { limit: 300, windowMs: DAY },
  /** Reading a page's open findings (no model call). */
  notesFindings: { limit: 120, windowMs: MINUTE },
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
  /**
   * Screen Coach questions (a model call with a screenshot). The monthly budget is the brief's
   * quota (§7.6); like every rule here it lives in memory, so a restart resets it.
   */
  screen: { limit: 10, windowMs: MINUTE },
  screenDaily: { limit: 200, windowMs: DAY },
  screenMonthly: { limit: 2000, windowMs: 30 * DAY },
  /**
   * Coach mode (S4, decision 10): starting a walkthrough is a planner call with a screenshot;
   * each step event is at most one fast verifier call. A 15-step walkthrough with every hint is
   * ~60 checks, so the daily budget allows several long ones.
   */
  coachStart: { limit: 4, windowMs: MINUTE },
  coachStartDaily: { limit: 30, windowMs: DAY },
  coachStep: { limit: 20, windowMs: MINUTE },
  coachStepDaily: { limit: 400, windowMs: DAY },
  coachStepMonthly: { limit: 4000, windowMs: 30 * DAY },
  /** Circle & Ask (S3.2, decision 11): an answer is a model call with two images. */
  circleAsk: { limit: 10, windowMs: MINUTE },
  circleAskDaily: { limit: 150, windowMs: DAY },
  circleAskMonthly: { limit: 1500, windowMs: 30 * DAY },
  /** Reading a handwritten question the student selected on screen (one small image). */
  readQuestion: { limit: 10, windowMs: MINUTE },
  readQuestionDaily: { limit: 100, windowMs: DAY },
  /** Saving clips from the screen (an upload to storage each), and reading them back. */
  clip: { limit: 10, windowMs: MINUTE },
  clipDaily: { limit: 200, windowMs: DAY },
  clipRead: { limit: 240, windowMs: MINUTE },
  /** Desktop sign-in: link codes per user, and code exchanges per client address. */
  deviceLink: { limit: 5, windowMs: MINUTE },
  deviceLinkDaily: { limit: 30, windowMs: DAY },
  deviceExchange: { limit: 10, windowMs: MINUTE },
  /** Listing and revoking devices. */
  devices: { limit: 60, windowMs: MINUTE },
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
