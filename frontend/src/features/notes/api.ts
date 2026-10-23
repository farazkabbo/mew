import type { NotePageSync } from "@mew/shared";

import type { SyncOutcome } from "./indexer";

/**
 * Sends one page's changed lines (`PUT /api/notes/pages/[pageId]/lines`). "off" means the
 * server refused because the notes_index setting is off; anything else unsuccessful is retried
 * on a later sync.
 */
export async function syncNotePage(
  pageId: string,
  body: NotePageSync,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<SyncOutcome> {
  try {
    const response = await fetchImpl(`/api/notes/pages/${encodeURIComponent(pageId)}/lines`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) return "ok";
    return response.status === 403 ? "off" : "failed";
  } catch {
    return "failed";
  }
}
