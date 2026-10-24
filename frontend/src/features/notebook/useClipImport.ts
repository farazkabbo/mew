import { ClipView, type Page } from "@mew/shared";
import { useEffect, useState } from "react";

import {
  OPEN_CLIP_EVENT,
  OPEN_ENTRY_EVENT,
  ScreenClipSavedDetail,
  ScreenEntrySavedDetail,
} from "../screen/events";
import { takePendingEntries } from "../screen/ScreenCoachBridge";
import type { NotebookRepository } from "./repository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A clip to bring into the notebook, and whether to show it once it's there. */
type Pending = { clipId: string; open: boolean };

/**
 * Builds the notebook page for a clip saved from the screen (Screen Coach S3, decision 9): the
 * desktop app hands over only the clip's id, either as `/notebook?clip=<id>` or as an event when
 * the notebook is already open. The clip is read with the student's own session, turned into a
 * local page (once per clip), and the server notes which page it became.
 *
 * A Circle & Ask entry (S3.2) arrives the same way (`?entry=`, or its own event) and goes on the
 * day's "From screen" page instead; it's shown only when the student asked (Open). A follow-up
 * saved to the same entry later brings it up to date.
 */
export function useClipImport({
  repo,
  notebookId,
  onOpened,
  onAdded,
  onError,
}: {
  repo: NotebookRepository;
  notebookId: string | null;
  onOpened: (page: Page) => void;
  /** An entry was added (or updated) without being shown. */
  onAdded: (page: Page) => void;
  onError: (message: string) => void;
}): void {
  const [queue, setQueue] = useState<Pending[]>([]);

  useEffect(() => {
    const add = (pending: Pending) => setQueue((list) => [...list, pending]);
    const url = new URL(window.location.href);
    for (const [param, open] of [
      ["clip", true],
      ["entry", true],
    ] as const) {
      const id = url.searchParams.get(param);
      if (id && UUID.test(id)) {
        // Dropped from the address, so a reload doesn't import it again (it wouldn't: once each).
        url.searchParams.delete(param);
        window.history.replaceState(null, "", url);
        queueMicrotask(() => add({ clipId: id, open }));
      }
    }
    // Entries saved while the notebook wasn't open.
    for (const clipId of takePendingEntries()) queueMicrotask(() => add({ clipId, open: false }));

    const onClip = (event: Event) => {
      const detail = ScreenClipSavedDetail.safeParse((event as CustomEvent<unknown>).detail);
      if (detail.success) add({ clipId: detail.data.clipId, open: true });
    };
    const onEntry = (event: Event) => {
      const detail = ScreenEntrySavedDetail.safeParse((event as CustomEvent<unknown>).detail);
      if (detail.success) add(detail.data);
    };
    window.addEventListener(OPEN_CLIP_EVENT, onClip);
    window.addEventListener(OPEN_ENTRY_EVENT, onEntry);
    return () => {
      window.removeEventListener(OPEN_CLIP_EVENT, onClip);
      window.removeEventListener(OPEN_ENTRY_EVENT, onEntry);
    };
  }, []);

  const next = queue[0];
  useEffect(() => {
    if (!next || !notebookId) return;
    let cancelled = false;
    void importClip(repo, notebookId, next.clipId)
      .then((page) => {
        if (cancelled) return;
        if (next.open) onOpened(page);
        else onAdded(page);
      })
      .catch(() => {
        if (!cancelled) onError("Couldn't open what you saved. Try again from Screen Coach.");
      })
      .finally(() => {
        if (!cancelled) setQueue((list) => list.slice(1));
      });
    return () => {
      cancelled = true;
    };
  }, [next, notebookId, repo, onOpened, onAdded, onError]);
}

async function importClip(
  repo: NotebookRepository,
  notebookId: string,
  clipId: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<Page> {
  const response = await fetchImpl(`/api/clips/${clipId}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`clip ${response.status}`);
  const clip = ClipView.parse(await response.json());
  const page = clip.entry
    ? await repo.importEntry(notebookId, clip)
    : await repo.importClip(notebookId, clip);
  // Best effort: lets another device or tab know this clip already has a page.
  void fetchImpl(`/api/clips/${clipId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notebookPageId: page.id }),
    keepalive: true,
  }).catch(() => undefined);
  return page;
}
