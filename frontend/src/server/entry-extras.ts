import "server-only";

import type { MomentMeta, SavedSolution } from "@mew/shared";

/**
 * What this server worked out about a Circle & Ask session that its entry should keep, waiting
 * for the desktop app to save it: the verified worked solution (K7) and the moment's subject and
 * check question (K8). Attached by `/api/screen/clips` and `/api/screen/entries/append`,
 * overwriting anything the device sent: none of it ever passes through the device.
 *
 * Kept in this process, by student and session, for 30 minutes (one instance, like decision 39).
 */
export type EntryExtras = { solution?: SavedSolution; moment?: MomentMeta };

const KEEP_MS = 30 * 60_000;
const KEPT_MAX = 500;

const kept = new Map<string, { extras: EntryExtras; at: number }>();
const key = (userId: string, sessionId: string) => `${userId}:${sessionId}`;

export function keepForEntry(userId: string, sessionId: string, extras: EntryExtras): void {
  const now = Date.now();
  for (const [k, v] of kept) if (now - v.at > KEEP_MS) kept.delete(k);
  const k = key(userId, sessionId);
  const before = kept.get(k)?.extras ?? {};
  if (!kept.has(k) && kept.size >= KEPT_MAX) kept.delete(kept.keys().next().value ?? "");
  // The first of each stays: a follow-up adds what the entry didn't have yet.
  kept.set(k, { extras: { ...extras, ...before }, at: now });
}

/** The session's extras, once (its entry is being saved). */
export function takeForEntry(userId: string, sessionId: string): EntryExtras {
  const k = key(userId, sessionId);
  const entry = kept.get(k);
  kept.delete(k);
  return entry && Date.now() - entry.at <= KEEP_MS ? entry.extras : {};
}

/** An entry part (new or appended) with this server's extras, and none of the device's. */
export function withServerExtras<
  T extends {
    sessionId: string;
    solution?: SavedSolution | undefined;
    moment?: MomentMeta | undefined;
  },
>(part: T, userId: string): T {
  const clean = { ...part };
  delete clean.solution;
  delete clean.moment;
  return { ...clean, ...takeForEntry(userId, part.sessionId) };
}
