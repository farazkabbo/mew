import "server-only";

import { type HandwritingSample, HandwritingSamples } from "@mew/shared";

import { userApi } from "./user-api";

export { profileForRecognition, summarizeProfile as summarize } from "@mew/shared";

/**
 * Each student's handwriting profile (K10 §8.3): their own corrected samples, kept by the API
 * service (RLS), read here at most every few minutes and used on every recognition call.
 */
const TTL_MS = 5 * 60_000;
const MAX_USERS = 500;

type Entry = { at: number; samples: HandwritingSample[] };
const cache = new Map<string, Entry>();

export type LoadSamples = () => Promise<HandwritingSample[]>;

const loadOwnSamples: LoadSamples = async () =>
  (await userApi("/v1/handwriting/samples", HandwritingSamples, { timeoutMs: 4000 })).samples;

/** The student's samples (cached). Empty when they can't be read: recognition still works. */
export async function samplesFor(
  userId: string,
  load: LoadSamples = loadOwnSamples,
  now = Date.now(),
): Promise<HandwritingSample[]> {
  const hit = cache.get(userId);
  if (hit && now - hit.at < TTL_MS) return hit.samples;
  let samples: HandwritingSample[];
  try {
    samples = await load();
  } catch {
    samples = hit?.samples ?? [];
  }
  cache.delete(userId);
  cache.set(userId, { at: now, samples });
  if (cache.size > MAX_USERS) cache.delete(cache.keys().next().value ?? "");
  return samples;
}

/** After the student adds samples or resets: read again next time. */
export function forgetSamples(userId: string): void {
  cache.delete(userId);
}
