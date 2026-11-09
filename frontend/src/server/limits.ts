import "server-only";

/**
 * Every launch limit in one place (docs/LAUNCH_LIMITS.md). Numbers that change on launch day
 * come from the environment; the rest are here.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function int(name: string, fallback: number, max = 10_000_000): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, max) : fallback;
}

function float(name: string, fallback: number): number {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export const LIMITS = {
  /** Questions each learner (and each computer) gets: FREE_QUESTION_LIMIT. */
  freeQuestions: () => int("FREE_QUESTION_LIMIT", 8, 100_000),
  /** `lifetime` (default) or `daily`: QUOTA_WINDOW. */
  daily: () => process.env.QUOTA_WINDOW === "daily",
  /** Founders and testers: never run out (NEB_UNLIMITED_EMAILS, comma-separated). */
  unlimitedEmails: () =>
    new Set(
      (process.env.NEB_UNLIMITED_EMAILS ?? "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  /** Model calls one question may make (follow-ups, the same question_id). */
  followUps: 8,
  /** A walkthrough's steps all belong to the question that started it. */
  walkthroughSteps: 40,
  /** How long a question_id stays usable for follow-ups. */
  questionTtlMs: 30 * MINUTE,
  /** A notebook turn this soon after the last question continues it (no new question). */
  notebookFollowUpMs: 5 * MINUTE,
  /** Sliding windows (Redis; in memory when Redis is down). */
  rate: {
    // Overridable for the journey test only (playwright.journey.config.ts); production uses these.
    askUserMinute: { limit: int("ASK_PER_MINUTE", 3), windowMs: MINUTE },
    askUserHour: { limit: int("ASK_PER_HOUR", 15), windowMs: HOUR },
    askIpMinute: { limit: int("ASK_IP_PER_MINUTE", 10), windowMs: MINUTE },
    sessionIp: { limit: 10, windowMs: 10 * MINUTE },
    /** The desktop app polls every 2 s for up to 3 minutes while a sign-in waits. */
    pollIp: { limit: 120, windowMs: 10 * MINUTE },
    waitlistIp: { limit: 5, windowMs: HOUR },
  },
  /** Everyone together, per UTC day: GLOBAL_DAILY_QUESTION_CAP and GLOBAL_DAILY_USD_CAP. */
  dailyQuestionCap: () => int("GLOBAL_DAILY_QUESTION_CAP", 2_000),
  dailyUsdCap: () => float("GLOBAL_DAILY_USD_CAP", 20),
  /** NEB_ASK_ENABLED=false stops every model call at once. */
  askEnabled: () => process.env.NEB_ASK_ENABLED !== "false",
  /** Answers kept for repeated questions (Redis). */
  cacheTtlS: 7 * 24 * 3600,
  /** How long "this learner has questions left" is trusted for background calls. */
  allowanceCacheS: 60,
} as const;

/**
 * The 8-question allowance is always on in production. Elsewhere (development, tests) it's on
 * with NEB_QUOTA=on, so local work and the test suites aren't capped by accident.
 */
export function quotaEnforced(): boolean {
  return process.env.NODE_ENV === "production" || process.env.NEB_QUOTA === "on";
}

/**
 * Rough prices, US dollars per million tokens (input, output), for the daily spend cap: kept on
 * the high side so the cap trips early rather than late. Unknown models get the highest.
 */
const PRICES: readonly [RegExp, number, number][] = [
  [/flash-lite/, 0.15, 0.6],
  [/flash/, 0.5, 3],
  [/pro/, 2.5, 15],
];

export function estimateUsd(model: string, input: number, output: number): number {
  const [, inPrice, outPrice] = PRICES.find(([pattern]) => pattern.test(model)) ?? [null, 2.5, 15];
  return (input * inPrice + output * outPrice) / 1_000_000;
}

/** ElevenLabs speech, US dollars per 1,000 characters (a conservative default). */
export const TTS_USD_PER_1K_CHARS = () => float("ELEVENLABS_USD_PER_1K_CHARS", 0.3);
