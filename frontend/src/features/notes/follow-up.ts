"use client";

import {
  type BoardAction,
  ExplainResult,
  GapHeadingResult,
  type NotesFinding,
  type ResolveRequest,
  ResolveResult,
  StoredFinding,
} from "@mew/shared";
import { useEffect } from "react";
import { z } from "zod";

import type { NotebookDb } from "../notebook/db";
import { useSettings } from "../settings/store";
import {
  findingById,
  type FindingProgress,
  isStored,
  progressOf,
  useNotesCheck,
} from "./check-store";
import { type LocalNoteLine, LocalNoteLines } from "./local-lines";

/**
 * Notes Check's follow-ups in the notebook (N5, brief §2.4–2.5): the student answers a
 * finding's question, says their note is right, asks to be told, adds a missing idea under a
 * heading the tutor writes, or simply edits the line. The server decides how each turned out
 * and records any learning evidence; this keeps the marks in step with that.
 */

type Fetch = typeof fetch;
const defaultFetch: Fetch = (...args) => fetch(...args);

/** Answers that still differ before the tutor explains instead (brief §2.4). */
const MISSES_BEFORE_EXPLAINING = 2;
/** What the server takes as a line's text (ResolveRequest.lineText). */
const LINE_TEXT_CHARS = 300;

const BUSY_REPLY = "That's a lot of checking for now. Try again in a little while.";
const FAILED_REPLY = "I couldn't check that just now. Try again in a moment.";

/** The student's answer to a finding's question (or "my note is right"). */
export async function answerFinding(
  findingId: string,
  reply: string,
  fetchImpl: Fetch = defaultFetch,
): Promise<void> {
  const result = await resolve(findingId, { reply }, fetchImpl);
  if (!result || result.status !== "open") return;
  const { misses } = progressOf(useNotesCheck.getState(), findingId);
  if (result.outcome === "needs_explanation" || misses >= MISSES_BEFORE_EXPLAINING) {
    await explainFinding(findingId, fetchImpl);
  }
}

/** "Tell me": the tutor explains what the material says. */
export async function explainFinding(
  findingId: string,
  fetchImpl: Fetch = defaultFetch,
): Promise<void> {
  const result = await send(findingId, "explain", {}, ExplainResult, fetchImpl);
  if (result) track(findingId, { status: result.status, reply: result.explanation, busy: false });
}

/** "Dismiss": hidden at once; the server is told so it isn't restored (nothing is recorded). */
export async function dismissFinding(
  findingId: string,
  fetchImpl: Fetch = defaultFetch,
): Promise<void> {
  const store = useNotesCheck.getState();
  store.dismiss(findingId);
  store.track(findingId, { status: "dismissed" });
  if (!isStored(store, findingId)) return;
  await fetchImpl(`/api/notes/findings/${findingId}/dismiss`, {
    method: "POST",
    cache: "no-store",
  }).catch(() => undefined); // dismissed here either way
}

/** Something that writes tutor ink on the page (the session's TutorInk). */
export type HeadingInk = {
  render(
    actions: readonly BoardAction[],
    options: { nearStrokes?: readonly string[] },
  ): Promise<unknown>;
};

/** A gap's "Add it": the tutor writes a heading under the line it follows, for the student. */
export async function addGapHeading(
  findingId: string,
  db: NotebookDb,
  ink: HeadingInk,
  fetchImpl: Fetch = defaultFetch,
): Promise<void> {
  const result = await send(findingId, "gap-heading", {}, GapHeadingResult, fetchImpl);
  if (!result) return;
  const anchor = await anchorLine(findingId, db);
  await ink.render(
    [{ type: "write_text", text: result.heading, anchor: { near: "below_active_line" } }],
    {
      ...(anchor && { nearStrokes: anchor.strokeIds }),
    },
  );
  track(findingId, {
    busy: false,
    headingWritten: true,
    reply: "Write what it means under the heading, in your own words. Then I'll check it.",
  });
}

/** "Check what I wrote": the line the student wrote under a gap's heading. */
export async function checkGapLine(
  findingId: string,
  db: NotebookDb,
  fetchImpl: Fetch = defaultFetch,
): Promise<void> {
  const anchor = await anchorLine(findingId, db);
  const lines = anchor ? await new LocalNoteLines(db).forPage(anchor.pageId) : [];
  const next = anchor && lineAfter(lines, anchor);
  if (!next) {
    track(findingId, { reply: "Write a line under the heading first, then I'll check it." });
    return;
  }
  await resolve(findingId, { lineText: next }, fetchImpl);
}

/**
 * Re-checks differences whose lines the student changed (brief §2.4): once per change of the
 * recognised text, and only while open. Edits aren't answers, so nothing nags: the mark changes
 * only when the line now matches.
 */
export function useRecheckOnEdit(lines: readonly LocalNoteLine[] | null): void {
  useEffect(() => {
    if (!lines) return;
    const state = useNotesCheck.getState();
    const findings = [
      ...(state.result?.findings ?? []),
      ...Object.values(state.restored).flat(),
    ].filter((f) => isStored(state, f.id));
    for (const edit of lineEdits(findings, lines, state.progress)) {
      state.track(edit.findingId, { lineText: edit.text });
      if (edit.changed)
        void resolve(edit.findingId, { lineText: edit.text }, defaultFetch, { quiet: true });
    }
  }, [lines]);
}

/** The page's findings still open on the server: its marks come back after a reload. */
export function useRestoredFindings(pageId: string | null, fetchImpl: Fetch = defaultFetch): void {
  const allowed = useSettings((s) => s.loaded && s.settings.notes_index);
  useEffect(() => {
    if (!pageId || !allowed || useNotesCheck.getState().restored[pageId]) return;
    let cancelled = false;
    void (async () => {
      const response = await fetchImpl(`/api/notes/findings?pageId=${pageId}`, {
        cache: "no-store",
      });
      if (!response.ok || cancelled) return;
      const stored = z.array(StoredFinding).parse(await response.json());
      useNotesCheck.getState().restore(pageId, stored.flatMap(fromStored));
    })().catch(() => undefined); // no marks restored: the notes are untouched
    return () => {
      cancelled = true;
    };
  }, [pageId, allowed, fetchImpl]);
}

// ─── Pure helpers (tested directly) ─────────────────────────────────────────────────────────

export type LineEdit = { findingId: string; text: string; changed: boolean };

/**
 * The open differences and unclear lines whose text is known: `changed` when it differs from
 * the text last seen (the first sighting only remembers it). Lines not recognised yet wait.
 */
export function lineEdits(
  findings: readonly NotesFinding[],
  lines: readonly LocalNoteLine[],
  progress: Readonly<Record<string, FindingProgress>>,
): LineEdit[] {
  const edits: LineEdit[] = [];
  for (const finding of findings) {
    if (finding.type !== "difference" && finding.type !== "unclear") continue;
    const seen = progress[finding.id];
    if (seen && (seen.status !== "open" || seen.busy)) continue;
    const text = textOf(lines.filter((line) => finding.lineIds.includes(line.id)));
    if (!text || text === seen?.lineText) continue;
    edits.push({ findingId: finding.id, text, changed: seen?.lineText !== undefined });
  }
  return edits;
}

/** The text of the first line below `anchor` (where the student writes under the heading). */
export function lineAfter(lines: readonly LocalNoteLine[], anchor: LocalNoteLine): string | null {
  const below = lines
    .filter((line) => !line.removed && line.lineIndex > anchor.lineIndex)
    .sort((a, b) => a.lineIndex - b.lineIndex);
  return below[0] ? textOf([below[0]]) : null;
}

/** A stored finding as a mark on the page: differences and unclear lines (a gap's place isn't stored). */
export function fromStored(stored: StoredFinding): NotesFinding[] {
  if (stored.status !== "open" || (stored.type !== "difference" && stored.type !== "unclear"))
    return [];
  return [
    {
      id: stored.id,
      type: stored.type,
      lineIds: stored.noteLineIds,
      blockIds: ["b1"],
      ...(stored.noteQuote && { noteQuote: stored.noteQuote }),
      screenQuote: stored.screenSnippet,
      ...(stored.question && { question: stored.question }),
      sourceConflict: stored.sourceConflict,
      ...(stored.conceptHint && { conceptHint: stored.conceptHint }),
      confidence: stored.confidence,
      evidence: [],
    },
  ];
}

function textOf(lines: readonly LocalNoteLine[]): string | null {
  const text = lines
    .filter((line) => !line.removed)
    .sort((a, b) => a.lineIndex - b.lineIndex)
    .map((line) => line.recognition?.text.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .slice(0, LINE_TEXT_CHARS);
  return text || null;
}

// ─── Requests ───────────────────────────────────────────────────────────────────────────────

function track(findingId: string, change: Partial<FindingProgress>): void {
  useNotesCheck.getState().track(findingId, change);
}

/** Asks how a reply or an edited line turned out, and shows it (`quiet`: only a settled outcome). */
async function resolve(
  findingId: string,
  body: ResolveRequest,
  fetchImpl: Fetch,
  { quiet = false } = {},
): Promise<ResolveResult | null> {
  const result = await send(findingId, "resolve", body, ResolveResult, fetchImpl, { quiet });
  if (!result) return null;
  const { misses } = progressOf(useNotesCheck.getState(), findingId);
  if (result.status !== "open") {
    track(findingId, { status: result.status, reply: result.reply, busy: false });
  } else if (quiet) {
    track(findingId, { busy: false });
  } else {
    const missed = result.outcome === "still_different" ? 1 : 0;
    track(findingId, { reply: result.reply, busy: false, misses: misses + missed });
  }
  return result;
}

/** One follow-up request; what went wrong is shown on the finding, never thrown. */
async function send<T>(
  findingId: string,
  action: "resolve" | "explain" | "gap-heading",
  body: unknown,
  schema: z.ZodType<T>,
  fetchImpl: Fetch,
  { quiet = false } = {},
): Promise<T | null> {
  const state = useNotesCheck.getState();
  if (!isStored(state, findingId) || progressOf(state, findingId).busy) return null;
  track(findingId, { busy: true });
  try {
    const response = await fetchImpl(`/api/notes/findings/${findingId}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 409) {
      // Settled elsewhere (another tab, or the desktop app): it simply goes away here.
      useNotesCheck.getState().dismiss(findingId);
      track(findingId, { status: "dismissed", busy: false });
      return null;
    }
    if (!response.ok) {
      track(findingId, {
        busy: false,
        ...(!quiet && { reply: response.status === 429 ? BUSY_REPLY : FAILED_REPLY }),
      });
      return null;
    }
    return schema.parse(await response.json());
  } catch {
    track(findingId, { busy: false, ...(!quiet && { reply: FAILED_REPLY }) });
    return null;
  }
}

/** The line a gap would follow, as this device knows it. */
async function anchorLine(findingId: string, db: NotebookDb): Promise<LocalNoteLine | null> {
  const finding = findingById(useNotesCheck.getState(), findingId);
  if (!finding?.insertAfterLineId) return null;
  return new LocalNoteLines(db).get(finding.insertAfterLineId);
}
