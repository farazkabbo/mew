import "server-only";

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

import { HttpError } from "./http-error";
import type { RateRule } from "./rate-limit";

/**
 * Upstash Redis (docs/LAUNCH_LIMITS.md): rate limits, the daily spend counters, follow-up
 * question ids and the answer cache, shared by every server instance. Postgres keeps the
 * 8-question count; Redis only limits and remembers.
 *
 * Without UPSTASH_REDIS_REST_URL/TOKEN (development, tests), or when Redis fails, a small store
 * in this process takes over: limits stay on (stricter, per instance), nothing fails open.
 */

let client: Redis | null | undefined;

export function redis(): Redis | null {
  if (client !== undefined) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  client = url && token ? new Redis({ url, token, retry: { retries: 1 } }) : null;
  return client;
}

/** Tests: forget the client (so env changes apply) and the in-memory store. */
export function resetRedis(): void {
  client = undefined;
  memory.clear();
  windows.clear();
  limiters.clear();
}

// ─── The in-memory stand-in ──────────────────────────────────────────────────────────────────

type Kept = { value: string; expiresAt: number };
const memory = new Map<string, Kept>();
const MAX_KEYS = 50_000;

function live(key: string, now = Date.now()): Kept | null {
  const kept = memory.get(key);
  if (!kept) return null;
  if (kept.expiresAt <= now) {
    memory.delete(key);
    return null;
  }
  return kept;
}

function put(key: string, value: string, ttlMs: number): void {
  memory.delete(key);
  memory.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (memory.size > MAX_KEYS) memory.delete(memory.keys().next().value ?? "");
}

const windows = new Map<string, number[]>();

function memoryLimit(key: string, rule: RateRule): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const hits = (windows.get(key) ?? []).filter((t) => now - t < rule.windowMs);
  if (hits.length >= rule.limit) {
    windows.set(key, hits);
    return { ok: false, retryAfterMs: (hits[0] ?? now) + rule.windowMs - now };
  }
  hits.push(now);
  windows.set(key, hits);
  if (windows.size > MAX_KEYS) windows.delete(windows.keys().next().value ?? "");
  return { ok: true, retryAfterMs: 0 };
}

// ─── What the gate uses ──────────────────────────────────────────────────────────────────────

const limiters = new Map<string, Ratelimit>();

function upstashLimiter(store: Redis, name: string, rule: RateRule): Ratelimit {
  const id = `${name}:${rule.limit}:${rule.windowMs}`;
  let limiter = limiters.get(id);
  if (!limiter) {
    limiter = new Ratelimit({
      redis: store,
      prefix: `rl:${name}`,
      limiter: Ratelimit.slidingWindow(rule.limit, `${Math.round(rule.windowMs / 1000)} s`),
      ephemeralCache: new Map(),
    });
    limiters.set(id, limiter);
  }
  return limiter;
}

/**
 * Throws 429 RATE_LIMITED (with Retry-After) when `key` has used its window. Redis first; when
 * it's missing or fails, the in-memory window (never "allow everything").
 */
export async function limitOrThrow(name: string, key: string, rule: RateRule): Promise<void> {
  let result: { ok: boolean; retryAfterMs: number } | null = null;
  const store = redis();
  if (store) {
    try {
      const { success, reset } = await upstashLimiter(store, name, rule).limit(key);
      result = { ok: success, retryAfterMs: Math.max(reset - Date.now(), 1000) };
    } catch {
      result = null;
    }
  }
  result ??= memoryLimit(`${name}:${key}`, rule);
  if (!result.ok) {
    throw new HttpError(
      429,
      "Too many questions at once. Give it a minute.",
      { "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)) },
      "RATE_LIMITED",
    );
  }
}

/** Adds `by` to a counter that expires `ttlS` after it was first made; returns the new total. */
export async function addTo(key: string, by: number, ttlS: number): Promise<number> {
  const store = redis();
  if (store) {
    try {
      const total = await store.incrbyfloat(key, by);
      if (total === by) await store.expire(key, ttlS);
      return total;
    } catch {
      // Falls through to memory.
    }
  }
  const kept = live(key);
  const total = (kept ? Number(kept.value) : 0) + by;
  put(key, String(total), kept ? kept.expiresAt - Date.now() : ttlS * 1000);
  return total;
}

export async function readNumber(key: string): Promise<number> {
  const store = redis();
  if (store) {
    try {
      return Number((await store.get<string | number>(key)) ?? 0);
    } catch {
      // Falls through to memory.
    }
  }
  return Number(live(key)?.value ?? 0);
}

export async function getJson<T>(key: string): Promise<T | null> {
  const store = redis();
  if (store) {
    try {
      return (await store.get<T>(key)) ?? null;
    } catch {
      // Falls through to memory.
    }
  }
  const kept = live(key);
  return kept ? (JSON.parse(kept.value) as T) : null;
}

export async function setJson(key: string, value: unknown, ttlS: number): Promise<void> {
  const store = redis();
  if (store) {
    try {
      await store.set(key, value, { ex: ttlS });
      return;
    } catch {
      // Falls through to memory.
    }
  }
  put(key, JSON.stringify(value), ttlS * 1000);
}

export async function remove(key: string): Promise<void> {
  const store = redis();
  if (store) {
    try {
      await store.del(key);
    } catch {
      // Falls through to memory.
    }
  }
  memory.delete(key);
}
