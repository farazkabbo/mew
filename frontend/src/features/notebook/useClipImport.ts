import { ClipView, type Page } from "@mew/shared";
import { useEffect, useState } from "react";

import { OPEN_CLIP_EVENT, ScreenClipSavedDetail } from "../screen/events";
import type { NotebookRepository } from "./repository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Builds the notebook page for a clip saved from the screen (Screen Coach S3, decision 9): the
 * desktop app hands over only the clip's id, either as `/notebook?clip=<id>` or as an event when
 * the notebook is already open. The clip is read with the student's own session, turned into a
 * local page (once per clip), and the server notes which page it became.
 */
export function useClipImport({
  repo,
  notebookId,
  onOpened,
  onError,
}: {
  repo: NotebookRepository;
  notebookId: string | null;
  onOpened: (page: Page) => void;
  onError: (message: string) => void;
}): void {
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("clip");
    if (fromUrl && UUID.test(fromUrl)) {
      // Drop it from the address, so a reload doesn't import it again (it wouldn't: once per clip).
      const url = new URL(window.location.href);
      url.searchParams.delete("clip");
      window.history.replaceState(null, "", url);
      queueMicrotask(() => setPending(fromUrl));
    }
    const onOpen = (event: Event) => {
      const detail = ScreenClipSavedDetail.safeParse((event as CustomEvent<unknown>).detail);
      if (detail.success) setPending(detail.data.clipId);
    };
    window.addEventListener(OPEN_CLIP_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CLIP_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!pending || !notebookId) return;
    let cancelled = false;
    void importClip(repo, notebookId, pending)
      .then((page) => {
        if (!cancelled) onOpened(page);
      })
      .catch(() => {
        if (!cancelled) onError("Couldn't open the clip you saved. Try again from Screen Coach.");
      })
      .finally(() => {
        if (!cancelled) setPending(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pending, notebookId, repo, onOpened, onError]);
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
  const page = await repo.importClip(notebookId, clip);
  // Best effort: lets another device or tab know this clip already has a page.
  void fetchImpl(`/api/clips/${clipId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notebookPageId: page.id }),
    keepalive: true,
  }).catch(() => undefined);
  return page;
}
