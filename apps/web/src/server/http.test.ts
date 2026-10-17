import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { assertSameOrigin, handle, HttpError, readJson } from "./http";
import { enforceRateLimit, MemoryRateLimiter } from "./rate-limit";

const Body = z.object({ n: z.number() });

function post(body: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/x", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
  });
}

describe("readJson", () => {
  it("parses and validates a JSON body", async () => {
    await expect(readJson(post('{"n":1}'), Body, 100)).resolves.toEqual({ n: 1 });
  });

  it.each([
    ["wrong content type", post('{"n":1}', { "content-type": "text/plain" }), 415],
    ["oversized body", post(JSON.stringify({ n: 1, pad: "x".repeat(500) })), 413],
    ["malformed JSON", post("{nope"), 400],
    ["schema mismatch", post('{"n":"1"}'), 400],
  ])("rejects %s", async (_label, request, status) => {
    await expect(readJson(request, Body, 100)).rejects.toMatchObject({ status });
  });
});

describe("assertSameOrigin", () => {
  it("accepts the app origin and rejects others or none", () => {
    expect(() => assertSameOrigin(post("{}"))).not.toThrow();
    expect(() => assertSameOrigin(post("{}", { origin: "https://evil.example" }))).toThrow(
      HttpError,
    );
    const noOrigin = new Request("http://localhost:3000/api/x", { method: "POST" });
    expect(() => assertSameOrigin(noOrigin)).toThrow(HttpError);
  });
});

describe("rate limiting", () => {
  it("allows up to the limit per window, then refuses with Retry-After", () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    const rules = { test: { limit: 2, windowMs: 1000 } };

    enforceRateLimit("u1", rules, { rateLimiter: limiter });
    enforceRateLimit("u1", rules, { rateLimiter: limiter });
    expect(() => enforceRateLimit("u1", rules, { rateLimiter: limiter })).toThrow(
      expect.objectContaining({ status: 429, headers: { "Retry-After": "1" } }),
    );
    enforceRateLimit("u2", rules, { rateLimiter: limiter }); // other users are unaffected

    now = 1001;
    expect(() => enforceRateLimit("u1", rules, { rateLimiter: limiter })).not.toThrow();
  });
});

describe("weighted rate limiting", () => {
  it("counts cost units (e.g. characters), not requests", () => {
    const limiter = new MemoryRateLimiter(() => 0);
    const rules = { chars: { limit: 100, windowMs: 1000 } };

    enforceRateLimit("u1", rules, { cost: 60, rateLimiter: limiter });
    expect(() => enforceRateLimit("u1", rules, { cost: 41, rateLimiter: limiter })).toThrow(
      expect.objectContaining({ status: 429 }),
    );
    expect(() => enforceRateLimit("u1", rules, { cost: 40, rateLimiter: limiter })).not.toThrow();
  });
});

describe("handle", () => {
  it("turns HttpErrors into JSON responses and hides unexpected errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const known = await handle(() => Promise.reject(new HttpError(418, "teapot")))();
    const unknown = await handle(() => Promise.reject(new Error("db password is hunter2")))();

    expect(known.status).toBe(418);
    expect(await known.json()).toEqual({ error: "teapot" });
    expect(unknown.status).toBe(500);
    expect(await unknown.text()).not.toContain("hunter2");
  });
});
