import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import { z } from "zod";

import { ApiError, apiFetch } from "./api-client";
import { onUsage } from "./gemini";
import { HttpError } from "./http-error";
import { learnerFacts, requireVerified } from "./learner-identity";
import { estimateUsd, LIMITS, quotaEnforced, TTS_USD_PER_1K_CHARS } from "./limits";
import { addTo, getJson, limitOrThrow, readNumber, setJson } from "./redis";

/**
 * The question gate (docs/LAUNCH_LIMITS.md): every route that starts a new question goes
 * through `startQuestion`, in this order: the kill switch and the day's cap → a follow-up of a
 * question already asked (free) → verified email → rate limits → reserve one question in
 * Postgres. The route then answers inside `question.run`, and calls `finish` once something
 * reached the learner, or `refund` when nothing did: our errors never cost a question.
 * Background model calls (checking, live marks…) only need `requireAllowance`.
 */

export type Asker = {
  userId: string;
  /** The desktop app's own id for the computer (a UUID it keeps in the keychain). */
  deviceId?: string | null;
  ip: string;
};

/** A follow-up group: model calls with the same key belong to one question. */
export type FollowUp = {
  key: string;
  cap: number;
  /** How long the group lasts after its last call (default: LIMITS.questionTtlMs). */
  ttlMs?: number;
};

export type Question = {
  /** The question's id (null when the allowance isn't enforced, or for a follow-up). */
  id: string | null;
  /** Questions left after this one (null: unlimited or not enforced). */
  remaining: number | null;
  followUp: boolean;
  /** Runs the model work, counting its tokens against this question and the day. */
  run<T>(work: () => T): T;
  finish(): Promise<void>;
  refund(): Promise<void>;
};

const DAY_S = 36 * 3600;
const day = () => new Date().toISOString().slice(0, 10);
const spendKey = (what: "q" | "usd") => `spend:${day()}:${what}`;

// ─── Spend: every model call adds what it cost to the day ────────────────────────────────────

type Usage = { model: string; input: number; output: number };
const current = new AsyncLocalStorage<Usage>();

onUsage((usage) => {
  const usd = estimateUsd(usage.model, usage.input + usage.thought, usage.output);
  void addTo(spendKey("usd"), usd, DAY_S);
  const mine = current.getStore();
  if (mine) {
    mine.model = usage.model;
    mine.input += usage.input;
    mine.output += usage.output + usage.thought;
  }
});

/** ElevenLabs speech: what it cost, added to the day (called by the speech route). */
export function noteSpeech(chars: number): void {
  void addTo(spendKey("usd"), (chars / 1000) * TTS_USD_PER_1K_CHARS(), DAY_S);
}

/** 503 AT_CAPACITY when the kill switch is off or today's cap is reached. Nobody is charged. */
export async function assertOpen(): Promise<void> {
  const capacity = () =>
    new HttpError(
      503,
      "neb is at capacity for today. Your questions are saved for tomorrow.",
      {},
      "AT_CAPACITY",
    );
  if (!LIMITS.askEnabled()) throw capacity();
  const [questions, usd] = await Promise.all([
    readNumber(spendKey("q")),
    readNumber(spendKey("usd")),
  ]);
  if (questions >= LIMITS.dailyQuestionCap() || usd >= LIMITS.dailyUsdCap()) throw capacity();
}

// ─── The allowance, through the API service (Postgres) ───────────────────────────────────────

const Reserved = z.object({ questionId: z.uuid(), remaining: z.number().int().min(0) });
const Allowance = z.object({
  used: z.number().int(),
  limit: z.number().int(),
  unlimited: z.boolean(),
  remaining: z.number().int(),
});
export type AllowanceView = z.infer<typeof Allowance>;
const Changed = z.object({ changed: z.boolean() });

const outOfQuestions = () =>
  new HttpError(
    429,
    `You've used your ${LIMITS.freeQuestions()} free questions. We'll email you when more open up.`,
    {},
    "QUOTA_EXCEEDED",
  );

/** The computer's id as stored: a hash, never the id itself. */
export function deviceHash(deviceId: string | null | undefined): string | null {
  if (!deviceId || !/^[0-9a-f-]{36}$/i.test(deviceId)) return null;
  return createHash("sha256").update(`neb-device:${deviceId.toLowerCase()}`).digest("hex");
}

export async function allowanceOf(userId: string): Promise<AllowanceView> {
  return apiFetch(
    `/v1/quota/allowance?user=${encodeURIComponent(userId)}&limit=${LIMITS.freeQuestions()}`,
    Allowance,
  );
}

async function reserve(asker: Asker, unlimited: boolean) {
  try {
    return await apiFetch("/v1/quota/reserve", Reserved, {
      method: "POST",
      body: {
        userId: asker.userId,
        deviceHash: deviceHash(asker.deviceId),
        limit: LIMITS.freeQuestions(),
        daily: LIMITS.daily(),
        unlimited,
      },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) throw outOfQuestions();
    if (error instanceof ApiError && error.status === null) {
      throw new HttpError(503, "The service is unavailable right now");
    }
    throw error;
  }
}

function question(
  id: string | null,
  remaining: number | null,
  followUp: boolean,
  asker: Asker,
): Question {
  const usage: Usage = { model: "", input: 0, output: 0 };
  let settled = !id;
  return {
    id,
    remaining,
    followUp,
    run: (work) => current.run(usage, work),
    finish: async () => {
      if (settled || !id) return;
      settled = true;
      await apiFetch(`/v1/quota/${id}/finish?user=${encodeURIComponent(asker.userId)}`, Changed, {
        method: "POST",
        body: { model: usage.model, inputTokens: usage.input, outputTokens: usage.output },
      }).catch(() => undefined);
    },
    refund: async () => {
      if (settled || !id) return;
      settled = true;
      await apiFetch(`/v1/quota/${id}/refund?user=${encodeURIComponent(asker.userId)}`, Changed, {
        method: "POST",
      }).catch(() => undefined);
      await addTo(spendKey("q"), -1, DAY_S);
    },
  };
}

type Group = { userId: string; questionId: string | null; calls: number };

/**
 * Starts a question, or continues `followUp` when it's a group this learner already started
 * (free, up to its cap). Throws AT_CAPACITY, EMAIL_UNVERIFIED, RATE_LIMITED or QUOTA_EXCEEDED.
 */
export async function startQuestion(asker: Asker, followUp?: FollowUp): Promise<Question> {
  await assertOpen();

  if (followUp) {
    const group = await getJson<Group>(followUp.key);
    if (group && group.userId === asker.userId) {
      if (group.calls >= followUp.cap) throw outOfQuestions();
      await setJson(
        followUp.key,
        { ...group, calls: group.calls + 1 },
        Math.round((followUp.ttlMs ?? LIMITS.questionTtlMs) / 1000),
      );
      return question(null, null, true, asker);
    }
  }

  if (!quotaEnforced()) {
    if (followUp) await rememberGroup(followUp, asker.userId, null);
    return question(null, null, false, asker);
  }

  const facts = await learnerFacts(asker.userId);
  requireVerified(facts);
  await limitOrThrow("ask:user:min", asker.userId, LIMITS.rate.askUserMinute);
  await limitOrThrow("ask:user:hour", asker.userId, LIMITS.rate.askUserHour);
  await limitOrThrow("ask:ip:min", asker.ip, LIMITS.rate.askIpMinute);

  const unlimited = facts.email !== null && LIMITS.unlimitedEmails().has(facts.email);
  const reserved = await reserve(asker, unlimited);
  await addTo(spendKey("q"), 1, DAY_S);
  await setJson(
    `allow:${asker.userId}`,
    reserved.remaining > 0 || unlimited,
    LIMITS.allowanceCacheS,
  );
  if (followUp) await rememberGroup(followUp, asker.userId, reserved.questionId);
  return question(reserved.questionId, unlimited ? null : reserved.remaining, false, asker);
}

/**
 * Opens a follow-up group for a question (e.g. a walkthrough, once its id is known): later calls
 * with the same key belong to that question, up to its cap.
 */
export async function rememberGroup(
  followUp: FollowUp,
  userId: string,
  questionId: string | null,
): Promise<void> {
  const group: Group = { userId, questionId, calls: 1 };
  await setJson(followUp.key, group, Math.round((followUp.ttlMs ?? LIMITS.questionTtlMs) / 1000));
}

/** Where an asker came from: its account, the computer's own id, and the address. */
export function askerOf(request: Request, userId: string): Asker {
  return {
    userId,
    deviceId: request.headers.get("x-neb-device"),
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown",
  };
}

/**
 * For model calls that aren't questions (checking work, live marks, reading handwriting):
 * allowed while the learner has questions left (cached a minute), and never past the day's cap.
 */
export async function requireAllowance(userId: string): Promise<void> {
  await assertOpen();
  if (!quotaEnforced()) return;
  const key = `allow:${userId}`;
  let allowed = await getJson<boolean>(key);
  if (allowed === null) {
    const found = await allowanceOf(userId).catch(() => null);
    allowed = found ? found.unlimited || found.remaining > 0 : true;
    await setJson(key, allowed, LIMITS.allowanceCacheS);
  }
  if (!allowed) throw outOfQuestions();
}

/** Headers that tell the client how many questions are left after this one. */
export function remainingHeaders(q: Question): Record<string, string> {
  return q.remaining === null ? {} : { "X-Neb-Questions-Left": String(q.remaining) };
}

/**
 * Streams a question's events as newline-delimited JSON. The question is finished once an event
 * `answered` says the learner got something; otherwise (an error, a dropped connection, a model
 * failure) it's refunded. The questions left go in a header.
 */
export function questionStream<E>(
  q: Question,
  events: () => AsyncIterable<E>,
  answered: (event: E) => boolean,
): Response {
  const encoder = new TextEncoder();
  let reached = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await q.run(async () => {
          for await (const event of events()) {
            if (!reached && answered(event)) reached = true;
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }
        });
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        await (reached ? q.finish() : q.refund());
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      ...remainingHeaders(q),
    },
  });
}
