import { PageDocument } from "@mew/ink";
import { RECOGNIZE_BATCH_MAX } from "@mew/shared";

import type { NotebookDb } from "../notebook/db";
import type { PageEngine } from "../notebook/engine";
import type { NotebookRepository } from "../notebook/repository";
import { useSettings } from "../settings/store";
import type { RecognitionService } from "../tutor/recognition";
import { useTutor } from "../tutor/store";
import { syncNotePage } from "./api";
import { NoteBackfill } from "./backfill";
import { NoteIndexer } from "./indexer";
import { LocalNoteLines } from "./local-lines";
import type { PageRef } from "./sync-plan";

/** Index a page once the pen has rested this long (as the tutor's recognition does). */
const INDEX_AFTER_MS = 1200;
/** The backfill waits until the student has stopped writing for this long. */
const QUIET_FOR_MS = 10_000;

/**
 * Notes Check N1 for one signed-in student's notebooks, independent of React: indexes the open
 * page after every pause in writing and catches up the rest in the background (`tick`).
 */
export function createNoteIndexing(
  db: NotebookDb,
  repo: NotebookRepository,
  recognition: RecognitionService,
) {
  let engine: PageEngine | null = null;
  let notebookId: string | null = null;
  let lastEdit = 0;

  const lines = new LocalNoteLines(db);
  const indexer = new NoteIndexer({
    lines,
    recognition,
    pageRef: (pageId) => pageRef(repo, pageId),
    sync: syncNotePage,
    syncEnabled,
    newId: () => crypto.randomUUID(),
  });
  const backfill = new NoteBackfill({
    indexer,
    candidatePages: () => candidatePages(repo, notebookId),
    pagesToSync: () => lines.pagesToSync(),
    loadPage: async (pageId) => {
      if (engine?.pageId === pageId) return { id: pageId, doc: engine.doc, images: engine.images };
      if (!(await repo.getPage(pageId))) return null;
      const [strokes, images] = await Promise.all([
        repo.loadStrokes(pageId),
        repo.loadImages(pageId),
      ]);
      return { id: pageId, doc: new PageDocument(strokes), images };
    },
    ready: () =>
      recognition.canBatch &&
      navigator.onLine &&
      document.visibilityState === "visible" &&
      Date.now() - lastEdit > QUIET_FOR_MS &&
      useTutor.getState().phase === "idle",
    syncEnabled,
    forgetSynced: () => lines.forgetSynced(),
  });

  return {
    /** Follows the notebook on screen (its pages are caught up first). */
    setNotebook(next: string | null) {
      notebookId = next;
    },

    /**
     * Follows the page on screen: catches it up now, then after every pause in writing. Returns
     * a function that stops following it.
     */
    follow(next: PageEngine): () => void {
      engine = next;
      const page = () => ({ id: next.pageId, doc: next.doc, images: next.images });
      void indexer.index(page(), { recognize: 0, currentFirst: false }).catch(report);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = next.subscribe((change) => {
        if (change === "tutor") return; // the tutor's ink isn't the student's notes
        lastEdit = Date.now();
        backfill.touched(next.pageId);
        clearTimeout(timer);
        timer = setTimeout(() => {
          void indexer
            .index(page(), { recognize: 1 + RECOGNIZE_BATCH_MAX, currentFirst: true })
            .catch(report);
        }, INDEX_AFTER_MS);
      });
      return () => {
        clearTimeout(timer);
        unsubscribe();
        if (engine === next) engine = null;
      };
    },

    /** One step of the background catch-up (called on a timer). */
    tick(): Promise<void> {
      return backfill.tick().catch(report);
    },
  };
}

export type NoteIndexing = ReturnType<typeof createNoteIndexing>;

/** The server copy is allowed once settings are known and notes_index is on. */
function syncEnabled(): boolean {
  const { loaded, settings } = useSettings.getState();
  return loaded && settings.notes_index;
}

async function pageRef(repo: NotebookRepository, pageId: string): Promise<PageRef | null> {
  const page = await repo.getPage(pageId);
  const notebook = page && (await repo.getNotebook(page.notebookId));
  if (!page || !notebook) return null;
  return {
    notebook: { id: notebook.id, title: notebook.title, courseId: notebook.courseId ?? null },
    pageIndex: page.index,
  };
}

/** The open notebook's pages, then the pages of notebooks that belong to a course. */
async function candidatePages(repo: NotebookRepository, openId: string | null): Promise<string[]> {
  const notebooks = (await repo.listNotebooks()).filter((n) => n.id === openId || n.courseId);
  notebooks.sort((a, b) => Number(b.id === openId) - Number(a.id === openId));
  const pages = await Promise.all(notebooks.map((n) => repo.listPages(n.id)));
  return pages.flat().map((p) => p.id);
}

function report(error: unknown): void {
  console.warn("[notes] indexing failed:", error instanceof Error ? error.message : error);
}
