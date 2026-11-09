import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ApiClient from "./api-client";
import { ApiError } from "./api-client";
import type * as LearnerIdentity from "./learner-identity";
import { HttpError } from "./http-error";
import { assertOpen, questionStream, requireAllowance, startQuestion } from "./question-gate";
import { resetRedis } from "./redis";

vi.mock("server-only", () => ({}));

const api = vi.hoisted(() => ({ calls: [] as string[], left: 8, verified: true }));

vi.mock("./api-client", async (original) => ({
  ...(await original<typeof ApiClient>()),
  apiFetch: vi.fn(async (path: string) => {
    api.calls.push(path.split("?")[0] ?? path);
    if (path.startsWith("/v1/quota/reserve")) {
      if (api.left <= 0) throw new ApiError("quota", 429, "QUOTA_EXCEEDED");
      api.left -= 1;
      return { questionId: "11111111-1111-4111-8111-111111111111", remaining: api.left };
    }
    if (path.startsWith("/v1/quota/allowance")) {
      return { used: 8 - api.left, limit: 8, unlimited: false, remaining: api.left };
    }
    return { changed: true };
  }),
}));

vi.mock("./learner-identity", async (original) => ({
  ...(await original<typeof LearnerIdentity>()),
  learnerFacts: vi.fn(async () => ({ verified: api.verified, email: "ayesha@example.com" })),
}));

const ASKER = { userId: "user_ayesha", deviceId: null, ip: "203.0.113.7" };

async function code(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return "ok";
  } catch (error) {
    return error instanceof HttpError ? error.code : String(error);
  }
}

beforeEach(() => {
  resetRedis();
  vi.stubEnv("NEB_QUOTA", "on");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  api.calls = [];
  api.left = 8;
  api.verified = true;
});

afterEach(() => vi.unstubAllEnvs());

describe("the question gate", () => {
  it("counts a question and says how many are left", async () => {
    const question = await startQuestion(ASKER);
    expect(question.remaining).toBe(7);
    expect(api.calls).toEqual(["/v1/quota/reserve"]);
  });

  it("says QUOTA_EXCEEDED when the allowance is used up", async () => {
    api.left = 0;
    expect(await code(startQuestion(ASKER))).toBe("QUOTA_EXCEEDED");
  });

  it("refuses the 4th question in a minute with RATE_LIMITED and Retry-After", async () => {
    for (let i = 0; i < 3; i++) await startQuestion(ASKER);
    const refused = await startQuestion(ASKER).catch((e: unknown) => e as HttpError);
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).code).toBe("RATE_LIMITED");
    expect(Number((refused as HttpError).headers["Retry-After"])).toBeGreaterThan(0);
    expect(api.left).toBe(5); // the refused one wasn't counted
  });

  it("is AT_CAPACITY at the day's cap or with the kill switch, and charges nobody", async () => {
    vi.stubEnv("GLOBAL_DAILY_QUESTION_CAP", "0");
    expect(await code(startQuestion(ASKER))).toBe("AT_CAPACITY");
    vi.stubEnv("GLOBAL_DAILY_QUESTION_CAP", "100");
    vi.stubEnv("NEB_ASK_ENABLED", "false");
    expect(await code(startQuestion(ASKER))).toBe("AT_CAPACITY");
    expect(await code(requireAllowance(ASKER.userId))).toBe("AT_CAPACITY");
    expect(api.calls).toEqual([]);
  });

  it("lets follow-ups of a question through free, up to their cap", async () => {
    const group = { key: "q:circle:session-1", cap: 3 };
    const first = await startQuestion(ASKER, group);
    expect(first.followUp).toBe(false);
    expect((await startQuestion(ASKER, group)).followUp).toBe(true);
    expect((await startQuestion(ASKER, group)).followUp).toBe(true);
    expect(await code(startQuestion(ASKER, group))).toBe("QUOTA_EXCEEDED");
    expect(api.calls.filter((c) => c === "/v1/quota/reserve")).toHaveLength(1);
    // Another learner can't ride on this one's question.
    const other = await startQuestion({ ...ASKER, userId: "user_other" }, group);
    expect(other.followUp).toBe(false);
  });

  it("asks for a verified email first (EMAIL_UNVERIFIED)", async () => {
    api.verified = false;
    expect(await code(startQuestion(ASKER))).toBe("EMAIL_UNVERIFIED");
    expect(api.calls).toEqual([]);
  });

  it("gives the question back when nothing reached the learner", async () => {
    const failed = await startQuestion(ASKER);
    const response = questionStream(
      failed,
      async function* () {
        yield { type: "error" };
      },
      (event) => event.type === "speech",
    );
    await response.text();
    expect(api.calls).toContain("/v1/quota/11111111-1111-4111-8111-111111111111/refund");

    api.calls = [];
    const answered = await startQuestion({ ...ASKER, userId: "user_answered" });
    const ok = questionStream(
      answered,
      async function* () {
        yield { type: "speech" };
      },
      (event) => event.type === "speech",
    );
    expect(ok.headers.get("X-Neb-Questions-Left")).toBe(String(api.left));
    await ok.text();
    expect(api.calls).toContain("/v1/quota/11111111-1111-4111-8111-111111111111/finish");
  });

  it("still limits, and Postgres still counts, when Redis is down", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.invalid");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "x");
    resetRedis();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Redis is down");
      }),
    );
    for (let i = 0; i < 3; i++) await startQuestion(ASKER);
    expect(await code(startQuestion(ASKER))).toBe("RATE_LIMITED");
    api.left = 0;
    expect(await code(startQuestion({ ...ASKER, userId: "user_b", ip: "203.0.113.8" }))).toBe(
      "QUOTA_EXCEEDED",
    );
    await expect(assertOpen()).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("stops background model calls once the questions are used up", async () => {
    api.left = 0;
    expect(await code(requireAllowance(ASKER.userId))).toBe("QUOTA_EXCEEDED");
  });

  it("doesn't count anything outside production unless asked (NEB_QUOTA)", async () => {
    vi.stubEnv("NEB_QUOTA", "");
    const question = await startQuestion(ASKER);
    expect(question.id).toBeNull();
    expect(api.calls).toEqual([]);
  });
});
