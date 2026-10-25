"use client";

import { type Notebook, NotebookTree } from "@mew/shared";
import { useEffect, useMemo, useState } from "react";

import type { NotebookRepository } from "../repository";
import { pullTree, pushTree } from "../tree-api";
import { TreeSync } from "../tree-sync";
import { noticeText } from "../tree-sync-plan";

/** How often the server's tree is pulled while the app is open (another device's edits). */
const PULL_EVERY_MS = 5 * 60_000;

/**
 * The notebook tree, live (K1): every change shows at once, whether it came from this tab,
 * another tab or a sync. Also keeps it synced: soon after each edit, on start, when the app
 * comes back into view or online, and now and then. Trash older than 30 days is emptied on
 * start. `null` until the first read.
 */
export function useNotebookTree(
  repo: NotebookRepository,
  onNotice: (text: string) => void,
  onError: (error: unknown) => void,
): { nodes: Notebook[] | null; tree: NotebookTree<Notebook> } {
  const [nodes, setNodes] = useState<Notebook[] | null>(null);

  useEffect(() => repo.tree.observe(setNodes, onError), [repo, onError]);

  useEffect(() => {
    const sync = new TreeSync({
      repo: repo.tree,
      push: (body) => pushTree(body),
      pull: () => pullTree(),
      notify: (notice) => onNotice(noticeText(notice)),
      online: () => navigator.onLine,
    });
    const pull = () => void sync.run({ pull: true }).catch(onError);
    void repo.tree.purgeExpired().then(pull, onError);
    const stopQueue = repo.tree.observeQueue(() => sync.schedule());
    const onVisible = () => {
      if (document.visibilityState === "visible") pull();
    };
    window.addEventListener("online", pull);
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(pull, PULL_EVERY_MS);
    return () => {
      stopQueue();
      sync.dispose();
      clearInterval(timer);
      window.removeEventListener("online", pull);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [repo, onNotice, onError]);

  const tree = useMemo(() => new NotebookTree(nodes ?? []), [nodes]);
  return { nodes, tree };
}
