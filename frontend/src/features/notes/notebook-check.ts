"use client";

import {
  type ImageBlock,
  type Notebook,
  NOTES_CHECK_LIMITS,
  NotesCheckResult,
  type NotesFinding,
  type RetrievalScope,
  type ScreenTextBlock,
} from "@mew/shared";
import { useEffect, useMemo, useState } from "react";

import type { NotebookDb } from "../notebook/db";
import type { PageEngine } from "../notebook/engine";
import { useNotesCheck } from "./check-store";
import { useRecheckOnEdit, useRestoredFindings } from "./follow-up";
import { cleanLineText, type LocalNoteLine, LocalNoteLines } from "./local-lines";
import { type PageMark, pageMarks } from "./marks";

/**
 * Notes Check from the notebook (N4): a saved clip's text checked against the rest of the notes
 * (the prompt after saving a clip, or "Check against my notes" on its page), and the marks of
 * the latest check on the page on screen.
 */

/** A clip's OCR text as screen blocks, a line each (within the request's limits). */
export function clipBlocks(ocrText: string): ScreenTextBlock[] {
  const blocks: ScreenTextBlock[] = [];
  let total = 0;
  for (const raw of ocrText.split("\n")) {
    const text = cleanLineText(raw, NOTES_CHECK_LIMITS.blockChars);
    if (!text) continue;
    if (blocks.length >= NOTES_CHECK_LIMITS.screenBlocks) break;
    if (total + text.length > NOTES_CHECK_LIMITS.screenChars) break;
    total += text.length;
    blocks.push({ blockId: `b${blocks.length + 1}`, text });
  }
  return blocks;
}

/** The notes a clip is checked against: its notebook's course, else the notebook. */
export function scopeFor(notebook: Pick<Notebook, "id" | "courseId">): RetrievalScope {
  return notebook.courseId
    ? { kind: "course", courseId: notebook.courseId }
    : { kind: "notebook", notebookId: notebook.id };
}

/** Checks a clip against the notes; the result (or what went wrong) lands in the store. */
export async function checkClip(
  image: ImageBlock,
  notebook: Pick<Notebook, "id" | "courseId">,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<void> {
  const store = useNotesCheck.getState();
  const screen = clipBlocks(image.ocrText ?? "");
  if (screen.length === 0) {
    store.fail("This clip has no text I can compare with your notes.");
    return;
  }
  store.start();
  try {
    const response = await fetchImpl("/api/notes/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ screen, scope: scopeFor(notebook), clipId: image.clipId }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429) {
      store.fail("You've checked your notes a lot recently. Try again in a little while.");
      return;
    }
    if (!response.ok) {
      store.fail("I couldn't check your notes just now. Try again in a moment.");
      return;
    }
    store.show(NotesCheckResult.parse(await response.json()));
  } catch {
    store.fail("I couldn't check your notes just now. Try again in a moment.");
  }
}

/** How long after an edit the marks re-read where the lines are (the indexer has run by then). */
const RELOAD_AFTER_MS = 2500;

/**
 * The marks on the page on screen: the latest check's, plus the page's findings still open from
 * earlier (restored after a reload). None while the student hides them. Edited lines with an
 * open question are re-checked (N5).
 */
export function usePageMarks(db: NotebookDb, engine: PageEngine | null): PageMark[] {
  const result = useNotesCheck((s) => s.result);
  const restored = useNotesCheck((s) => (engine ? s.restored[engine.pageId] : undefined));
  const dismissed = useNotesCheck((s) => s.dismissed);
  const progress = useNotesCheck((s) => s.progress);
  const hidden = useNotesCheck((s) => s.marksHidden);
  const store = useMemo(() => new LocalNoteLines(db), [db]);
  const [loaded, setLoaded] = useState<{ pageId: string; lines: LocalNoteLine[] } | null>(null);
  const hasFindings = result !== null || (restored?.length ?? 0) > 0;

  useRestoredFindings(engine?.pageId ?? null);
  const lines = engine && loaded?.pageId === engine.pageId ? loaded.lines : null;
  useRecheckOnEdit(lines);

  useEffect(() => {
    if (!engine || !hasFindings) return;
    let cancelled = false;
    const load = () => {
      void store.forPage(engine.pageId).then((lines) => {
        if (!cancelled) setLoaded({ pageId: engine.pageId, lines });
      });
    };
    load();
    let timer: number | undefined;
    const unsubscribe = engine.subscribe(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, RELOAD_AFTER_MS);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [engine, hasFindings, store]);

  return useMemo(() => {
    if (hidden || !lines) return [];
    const latest = result?.findings ?? [];
    const earlier = (restored ?? []).filter((f) => !latest.some((l) => l.id === f.id));
    const settled = new Set(
      Object.entries(progress)
        .filter(([, p]) => p.status !== "open" && p.status !== "dismissed")
        .map(([id]) => id),
    );
    return pageMarks([...latest, ...earlier], lines, {
      dismissed,
      settled,
      ...(result?.source && { source: result.source }),
    });
  }, [result, restored, hidden, lines, dismissed, progress]);
}

/** The page a finding is on (its first line's, or for a gap the line it would follow). */
export async function pageOfFinding(
  db: NotebookDb,
  finding: Pick<NotesFinding, "lineIds" | "insertAfterLineId">,
): Promise<string | null> {
  const lineId = finding.lineIds[0] ?? finding.insertAfterLineId;
  if (!lineId) return null;
  return (await new LocalNoteLines(db).get(lineId))?.pageId ?? null;
}
