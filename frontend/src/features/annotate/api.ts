import { type LiveMarkRequest, LiveMarkResponse } from "@mew/shared";

import { useMarkPrefs } from "./prefs";

/** A 429 asking to wait longer than this is the day's budget, not a burst (§7.5). */
export const BUDGET_PAUSE_MS = 10 * 60_000;

/**
 * A margin note for a line of writing (K9, Coach level), or null. When the day's budget for it
 * is spent, marking drops to Quiet for the rest of the day.
 */
export async function liveMarkNote(request: LiveMarkRequest): Promise<string | null> {
  const response = await fetch("/api/annotate/mark", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!response) return null;
  if (response.status === 429) {
    const seconds = Number(response.headers.get("Retry-After")) || 0;
    if (seconds * 1000 > BUDGET_PAUSE_MS) useMarkPrefs.getState().budgetSpent();
    return null;
  }
  if (!response.ok) return null;
  const parsed = LiveMarkResponse.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.note : null;
}
