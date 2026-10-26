import "server-only";

import {
  type CheckedFinding,
  type CompareLine,
  NO_RELATED_NOTES_SPEECH,
  NOTES_COMPARE_PROMPT,
  type NotesCheckResult,
  type NotesFinding,
  type NotesRetrieval,
  type NotesSource,
  type RetrievalScope,
  type ScreenTextBlock,
  scopeLabel,
} from "@mew/shared";

import { notesModel, verifierModel } from "../env";
import { generateStructured } from "../gemini";
import { type Asker, type CheckToStore, retrieveNotes, saveCheck } from "./api";
import { type CompareDeps, compareNotes } from "./compare";
import { checkEquivalence } from "./equivalence";

export type NotesCheckRequest = {
  screen: readonly ScreenTextBlock[];
  scope: RetrievalScope;
  /** The app in front (desktop checks). */
  app: string | null;
  /** Where the material came from: a saved clip, or a page or video. */
  clipId?: string;
  source?: NotesSource;
};

export type RunDeps = {
  retrieve: typeof retrieveNotes;
  save: typeof saveCheck;
  compare: CompareDeps;
  now: () => number;
  newId: () => string;
};

export const defaultRunDeps = (): RunDeps => ({
  retrieve: retrieveNotes,
  save: saveCheck,
  compare: {
    generate: generateStructured,
    equivalence: checkEquivalence,
    models: { compare: notesModel(), verifier: verifierModel() },
  },
  now: () => performance.now(),
  newId: () => crypto.randomUUID(),
});

/** Link chips made per check (from matches; brief §8). */
const MAX_LINKS = 8;

/**
 * "Check my notes" end to end: the related notes (or "no related notes", with no model call),
 * the comparison, then the findings kept for the resolution loop (N5). Speech never waits for
 * storage to succeed: a check that can't be stored still answers, with fresh finding ids.
 */
export async function runNotesCheck(
  request: NotesCheckRequest,
  asker: Asker,
  deps: RunDeps = defaultRunDeps(),
  signal?: AbortSignal,
): Promise<NotesCheckResult> {
  const started = deps.now();
  const elapsed = () => Math.round(deps.now() - started);
  // A saved clip is checked against the rest of the notes, never against itself.
  const retrieval = await deps.retrieve(asker, request.screen, request.scope, request.clipId);
  if (!retrieval.related) {
    log({ related: false, ms: elapsed() });
    return {
      checkId: null,
      related: false,
      topic: "",
      speech: NO_RELATED_NOTES_SPEECH,
      scopeLabel: "",
      pages: [],
      findings: [],
      latencyMs: elapsed(),
    };
  }

  const { notes, uuidOf } = promptLines(retrieval);
  const comparison = await compareNotes(
    { subject: null, screen: request.screen, notes, course: retrieval.passages },
    deps.compare,
    signal,
  );
  const findings = comparison.findings.map((f) => toResult(f, uuidOf, deps.newId));

  let checkId: string | null = null;
  try {
    const saved = await deps.save(
      asker,
      toStore(
        request,
        retrieval,
        comparison.findings,
        findings,
        deps.compare.models.compare,
        elapsed(),
      ),
    );
    checkId = saved.checkId;
    saved.findingIds.forEach((id, i) => {
      const finding = findings[i];
      if (id && finding) finding.id = id;
    });
  } catch (error) {
    console.warn(
      "[notes-check] couldn't store the check:",
      error instanceof Error ? error.name : "error",
    );
  }

  log({
    related: true,
    lines: notes.length,
    findings: countByType(findings),
    dropped: comparison.stats.dropped,
    downgraded: comparison.stats.downgraded,
    sympy: comparison.stats.sympyMatches,
    secondOpinion: comparison.stats.secondOpinionDowngrades,
    ms: elapsed(),
  });
  const source = checkedSource(request);
  return {
    checkId,
    related: true,
    topic: comparison.topic,
    speech: comparison.speech,
    scopeLabel: scopeLabel(retrieval.pages),
    pages: retrieval.pages,
    findings,
    ...(source && { source }),
    latencyMs: elapsed(),
  };
}

/** What the matches link to: the clip, else the page or video (only with its link). */
function checkedSource(request: NotesCheckRequest): NotesCheckResult["source"] | undefined {
  if (request.clipId) return { clipId: request.clipId };
  const { url, title, timestampSec } = request.source ?? {};
  if (!url) return undefined;
  return {
    url,
    ...(title && { title }),
    ...(timestampSec !== undefined && { timestampSec }),
  };
}

/** The retrieved lines as the prompt shows them: short ids, page numbers from 1. */
function promptLines(retrieval: NotesRetrieval): {
  notes: CompareLine[];
  uuidOf: Map<string, string>;
} {
  const pageNumber = new Map(retrieval.pages.map((p) => [p.pageId, p.pageIndex + 1]));
  const uuidOf = new Map<string, string>();
  const notes = retrieval.lines.map((line, i) => {
    const id = `L${i + 1}`;
    uuidOf.set(id, line.lineId);
    return {
      id,
      page: pageNumber.get(line.pageId) ?? 1,
      text: line.text,
      latex: line.latex,
      confidence: line.confidence,
      source: line.source,
      mark: line.mark ?? null,
    };
  });
  return { notes, uuidOf };
}

function toResult(
  finding: CheckedFinding,
  uuidOf: ReadonlyMap<string, string>,
  newId: () => string,
): NotesFinding {
  const insertAfter = finding.insertAfter ? uuidOf.get(finding.insertAfter) : undefined;
  return {
    id: newId(),
    type: finding.type,
    lineIds: finding.lineIds.map((id) => uuidOf.get(id)).filter((id) => id !== undefined),
    blockIds: finding.blockIds,
    ...(finding.noteQuote && { noteQuote: finding.noteQuote }),
    screenQuote: finding.screenQuote,
    ...(finding.question && { question: finding.question }),
    ...(insertAfter && { insertAfterLineId: insertAfter }),
    sourceConflict: finding.sourceConflict,
    ...(finding.conceptHint && { conceptHint: finding.conceptHint }),
    confidence: finding.confidence,
    evidence: finding.evidence,
  };
}

function toStore(
  request: NotesCheckRequest,
  retrieval: NotesRetrieval,
  checked: readonly CheckedFinding[],
  findings: readonly NotesFinding[],
  model: string,
  latencyMs: number,
): CheckToStore {
  const source = request.source;
  const links = findings
    .flatMap((finding, index) =>
      finding.type === "match" && (request.clipId || source?.url)
        ? finding.lineIds.map((noteLineId) => ({
            noteLineId,
            finding: index,
            ...(request.clipId && { clipId: request.clipId }),
            ...(!request.clipId && source?.url && { url: source.url }),
            ...(!request.clipId && source?.title && { title: source.title }),
            ...(!request.clipId &&
              source?.timestampSec !== undefined && { timestampSec: source.timestampSec }),
          }))
        : [],
    )
    .slice(0, MAX_LINKS);
  return {
    scope: retrieval.scope,
    sourceApp: request.app,
    modelVersion: `${NOTES_COMPARE_PROMPT.id} ${model}`,
    latencyMs,
    findings: findings.map((finding, i) => {
      // The page a finding belongs to: its first line's, or (a gap) the line it would follow.
      const anchor = finding.lineIds[0] ?? finding.insertAfterLineId;
      return {
        type: finding.type,
        noteLineIds: finding.lineIds,
        ...(anchor && { anchorLineId: anchor }),
        ...(finding.noteQuote && { noteQuote: finding.noteQuote }),
        screenSnippet: finding.screenQuote,
        ...(finding.question && { question: finding.question }),
        explanation: checked[i]?.explanation ?? "",
        ...(finding.conceptHint && { conceptHint: finding.conceptHint }),
        confidence: finding.confidence,
        sourceConflict: finding.sourceConflict,
      };
    }),
    links,
  };
}

function countByType(findings: readonly NotesFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.type] = (counts[f.type] ?? 0) + 1;
  return counts;
}

/** Counts and timings only: never quotes, note text, screen text, titles or links (§11). */
function log(fields: Record<string, unknown>): void {
  console.info(`[notes-check] ${JSON.stringify(fields)}`);
}
