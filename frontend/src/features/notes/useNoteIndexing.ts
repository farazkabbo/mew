"use client";

import { useEffect, useMemo } from "react";

import type { NotebookDb } from "../notebook/db";
import type { PageEngine } from "../notebook/engine";
import type { NotebookRepository } from "../notebook/repository";
import type { RecognitionService } from "../tutor/recognition";
import { createNoteIndexing } from "./note-indexing";

/** The background catch-up's pace: one batch of at most 8 lines per tick. */
const BACKFILL_EVERY_MS = 15_000;

type Options = {
  db: NotebookDb;
  repo: NotebookRepository;
  engine: PageEngine | null;
  notebookId: string | null;
  recognition: RecognitionService;
};

/**
 * Notes Check N1 on the notebook screen: after every writing pause, the page's lines are saved
 * with their text and synced; in the background, lines never recognised are caught up slowly.
 */
export function useNoteIndexing({ db, repo, engine, notebookId, recognition }: Options): void {
  const indexing = useMemo(
    () => createNoteIndexing(db, repo, recognition),
    [db, repo, recognition],
  );

  useEffect(() => indexing.setNotebook(notebookId), [indexing, notebookId]);
  useEffect(() => (engine ? indexing.follow(engine) : undefined), [indexing, engine]);
  useEffect(() => {
    const timer = window.setInterval(() => void indexing.tick(), BACKFILL_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [indexing]);
}
