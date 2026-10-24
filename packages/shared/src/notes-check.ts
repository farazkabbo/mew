import { z } from "zod";

import { ClipUrl } from "./clips";
import { BBox } from "./notebook";
import { NoteLineSource } from "./notes";
import { AppName } from "./screen";

/**
 * Notes Check (docs/SCREEN_COACH_NOTES_CHECK.md): the screen compared with the student's own
 * notes. Retrieval (N2) and storage run in the API service (backend/src/mew_api/notes/); the
 * comparison (N3) runs in the web app's server: frontend/src/server/notes-check/.
 */
export const NOTES_CHECK_LIMITS = {
  screenBlocks: 80,
  blockChars: 1000,
  screenChars: 8000,
  quoteChars: 200,
  explanationChars: 300,
  questionChars: 240,
  /** The brief's 25 words, with some slack: longer questions are dropped, never cut. */
  questionWords: 35,
  speechChars: 400,
  topicChars: 80,
  conceptChars: 80,
  /** Caps after validation (brief §6.4). */
  differences: 5,
  unclears: 5,
  gaps: 4,
  matches: 8,
  /** A difference needs at least this confidence (brief §6.4). */
  differenceConfidence: 0.8,
  /** Below this recognition confidence a line can only be "unclear" (brief §6.1). */
  lowRecognition: 0.6,
} as const;

const PlainText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((text) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text), {
      message: "control characters aren't allowed",
    });

export const BlockId = z.string().regex(/^[A-Za-z0-9_-]{1,16}$/);

/** A block of text on the screen (on-device OCR, after redaction): material, never instructions. */
export const ScreenTextBlock = z.object({
  blockId: BlockId,
  text: PlainText(NOTES_CHECK_LIMITS.blockChars).trim().min(1),
});
export type ScreenTextBlock = z.infer<typeof ScreenTextBlock>;

export const ScreenTextBlocks = z
  .array(ScreenTextBlock)
  .min(1)
  .max(NOTES_CHECK_LIMITS.screenBlocks)
  .refine(
    (blocks) => blocks.reduce((n, b) => n + b.text.length, 0) <= NOTES_CHECK_LIMITS.screenChars,
    {
      message: "too much screen text",
    },
  )
  .refine((blocks) => new Set(blocks.map((b) => b.blockId)).size === blocks.length, {
    message: "each block appears once",
  });

// ─── Retrieval (the API service's answer; mirrors backend/src/mew_api/notes/models.py) ──────

export const RetrievalScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }),
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("notebook"), notebookId: z.uuid() }),
  z.object({ kind: z.literal("course"), courseId: z.uuid() }),
]);
export type RetrievalScope = z.infer<typeof RetrievalScope>;

export const RetrievedNoteLine = z.object({
  lineId: z.uuid(),
  pageId: z.uuid(),
  lineIndex: z.number().int(),
  bbox: BBox,
  source: NoteLineSource,
  clipId: z.uuid().nullable(),
  text: z.string(),
  latex: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  hit: z.boolean(),
});
export type RetrievedNoteLine = z.infer<typeof RetrievedNoteLine>;

export const RetrievedPage = z.object({
  pageId: z.uuid(),
  notebookId: z.uuid(),
  notebookTitle: z.string(),
  pageIndex: z.number().int().nonnegative(),
});
export type RetrievedPage = z.infer<typeof RetrievedPage>;

export const CoursePassage = z.object({
  page: z.number().int(),
  heading: z.string().nullable(),
  text: z.string(),
});
export type CoursePassage = z.infer<typeof CoursePassage>;

export const NotesRetrieval = z.object({
  scope: z.object({
    kind: z.enum(["notebook", "course", "all"]),
    courseId: z.uuid().nullable().optional(),
    notebookIds: z.array(z.uuid()),
  }),
  related: z.boolean(),
  pages: z.array(RetrievedPage),
  lines: z.array(RetrievedNoteLine),
  passages: z.array(CoursePassage),
});
export type NotesRetrieval = z.infer<typeof NotesRetrieval>;

// ─── The comparison model's output (brief §6.2) ─────────────────────────────────────────────

export const FindingType = z.enum(["match", "difference", "gap", "unclear"]);
export type FindingType = z.infer<typeof FindingType>;

/**
 * One finding as the model returns it. Line ids are the short ones of the prompt ("L1"…); code
 * maps them back. Fields the model may leave out are optional; nothing has a default (Gemini
 * skips fields with defaults: HANDOFF §4).
 */
export const ModelFinding = z.object({
  type: FindingType,
  lineIds: z.array(z.string().max(8)).max(12),
  blockIds: z.array(z.string().max(16)).max(12),
  /** Exact text from a referenced note line; "" for a gap. Required, so the model never skips it. */
  noteQuote: z.string().max(600),
  screenQuote: z.string().max(600),
  explanation: z.string().max(1000),
  /** The guiding question; "" for a match. Required, so the model never skips it. */
  question: z.string().max(600),
  suggestedInsertAfterLineId: z.string().max(8).optional(),
  sourceConflict: z.boolean().optional(),
  conceptHint: z.string().max(200).optional(),
  /** LaTeX of the note's and the screen's claims, when both are equations or values. */
  noteMath: z.string().max(300).optional(),
  screenMath: z.string().max(300).optional(),
  confidence: z.number().min(0).max(1),
});
export type ModelFinding = z.infer<typeof ModelFinding>;

export const NotesCompareOutput = z.object({
  topic: z.string().max(200),
  speech: z.string().max(1000),
  findings: z.array(ModelFinding).max(24),
});
export type NotesCompareOutput = z.infer<typeof NotesCompareOutput>;

/** The second-opinion check of one difference (brief §6.5). */
export const SecondOpinion = z.object({
  conflict: z.boolean(),
  reason: z.string().max(400),
});
export type SecondOpinion = z.infer<typeof SecondOpinion>;

// ─── What a check returns ───────────────────────────────────────────────────────────────────

/** How a difference came to be kept (or a match to be one): for the panel and the evals. */
export const FindingEvidence = z.enum(["model", "sympy", "second_opinion"]);
export type FindingEvidence = z.infer<typeof FindingEvidence>;

export const NotesFinding = z.object({
  /** The stored finding's id (N5 resolves it), or a fresh id when it couldn't be stored. */
  id: z.uuid(),
  type: FindingType,
  lineIds: z.array(z.uuid()),
  blockIds: z.array(BlockId).min(1),
  noteQuote: z.string().max(NOTES_CHECK_LIMITS.quoteChars).optional(),
  screenQuote: z.string().max(NOTES_CHECK_LIMITS.quoteChars),
  question: z.string().max(NOTES_CHECK_LIMITS.questionChars).optional(),
  insertAfterLineId: z.uuid().optional(),
  sourceConflict: z.boolean(),
  conceptHint: z.string().max(NOTES_CHECK_LIMITS.conceptChars).optional(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(FindingEvidence),
});
export type NotesFinding = z.infer<typeof NotesFinding>;

/** What the matched lines link to (their link chips): a saved clip, or a page or video. */
export const CheckedSource = z.object({
  clipId: z.uuid().optional(),
  url: ClipUrl.optional(),
  title: PlainText(200).optional(),
  timestampSec: z.number().int().min(0).max(86_400).optional(),
});
export type CheckedSource = z.infer<typeof CheckedSource>;

export const NotesCheckResult = z.object({
  checkId: z.uuid().nullable(),
  related: z.boolean(),
  topic: z.string().max(NOTES_CHECK_LIMITS.topicChars),
  speech: z.string().max(NOTES_CHECK_LIMITS.speechChars),
  /** "Compared with Biology, pages 3–5" (brief §2.2). */
  scopeLabel: z.string().max(300),
  pages: z.array(RetrievedPage),
  findings: z.array(NotesFinding),
  /** Absent when the material has no link (e.g. a desktop app with no address bar). */
  source: CheckedSource.optional(),
  latencyMs: z.number().int().nonnegative(),
});
export type NotesCheckResult = z.infer<typeof NotesCheckResult>;

// ─── Requests ───────────────────────────────────────────────────────────────────────────────

/**
 * Where the screen's material came from, for the link chips of matched lines (brief §8): the
 * page or video, trimmed like a clip's link (no query strings but YouTube's v and t).
 */
export const NotesSource = z.object({
  url: ClipUrl.optional(),
  title: PlainText(200).trim().min(1).optional(),
  timestampSec: z.number().int().min(0).max(86_400).optional(),
});
export type NotesSource = z.infer<typeof NotesSource>;

/** `POST /api/screen/notes-check`: "check my notes" from the desktop app (device token). */
export const ScreenNotesCheckRequest = z.object({
  screen: ScreenTextBlocks,
  app: AppName.nullable(),
  source: NotesSource.optional(),
  /** "all": the student said "check against all my notes". */
  scope: z.enum(["default", "all"]),
});
export type ScreenNotesCheckRequest = z.infer<typeof ScreenNotesCheckRequest>;

/** `POST /api/notes/check`: a check started in the notebook (a clip's page, the notebook button). */
export const NotebookNotesCheckRequest = z.object({
  screen: ScreenTextBlocks,
  scope: RetrievalScope,
  /** The clip the text came from, when it's a saved clip. */
  clipId: z.uuid().optional(),
});
export type NotebookNotesCheckRequest = z.infer<typeof NotebookNotesCheckRequest>;

/** "Compared with Biology, pages 3–5" (pages numbered from 1). */
export function scopeLabel(pages: readonly RetrievedPage[]): string {
  if (pages.length === 0) return "";
  const byNotebook = new Map<string, number[]>();
  for (const page of pages) {
    const numbers = byNotebook.get(page.notebookTitle) ?? [];
    numbers.push(page.pageIndex + 1);
    byNotebook.set(page.notebookTitle, numbers);
  }
  const parts = [...byNotebook].map(([title, numbers]) => {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    const first = sorted[0] ?? 0;
    const last = sorted.at(-1) ?? first;
    const contiguous = last - first === sorted.length - 1;
    const label =
      sorted.length === 1
        ? `page ${first}`
        : contiguous
          ? `pages ${first}–${last}`
          : `pages ${sorted.join(", ")}`;
    return `${title}, ${label}`;
  });
  return `Compared with ${parts.join("; ")}`;
}

// ─── Resolution (N5, brief §2.4–2.5, §7) ────────────────────────────────────────────────────

export const FindingStatus = z.enum([
  "open",
  "resolved_fixed",
  "resolved_student_right",
  "dismissed",
  "explained",
]);
export type FindingStatus = z.infer<typeof FindingStatus>;

/** A stored finding, as the API service returns it (mirrors notes/models.py FindingView). */
export const StoredFinding = z.object({
  id: z.uuid(),
  checkId: z.uuid(),
  type: FindingType,
  noteLineIds: z.array(z.uuid()),
  pageId: z.uuid().nullable(),
  noteQuote: z.string().nullable(),
  screenSnippet: z.string(),
  question: z.string().nullable(),
  explanation: z.string(),
  conceptHint: z.string().nullable(),
  conceptId: z.uuid().nullable(),
  confidence: z.number(),
  sourceConflict: z.boolean(),
  status: FindingStatus,
  courseId: z.uuid().nullable(),
});
export type StoredFinding = z.infer<typeof StoredFinding>;

/** `POST /api/notes/findings/[id]/resolve`: what the student said, and/or the line as it is now. */
export const ResolveRequest = z
  .object({
    reply: PlainText(500).trim().min(1).optional(),
    lineText: PlainText(300).trim().min(1).optional(),
  })
  .refine((r) => r.reply !== undefined || r.lineText !== undefined, {
    message: "a reply or the line's new text",
  });
export type ResolveRequest = z.infer<typeof ResolveRequest>;

export const ResolveOutcome = z.enum([
  "fixed",
  "student_right",
  "still_different",
  "needs_explanation",
]);
export type ResolveOutcome = z.infer<typeof ResolveOutcome>;

/** What the resolve model returns. */
export const ResolveOutput = z.object({
  outcome: ResolveOutcome,
  reply: z.string().max(600),
});
export type ResolveOutput = z.infer<typeof ResolveOutput>;

export const ResolveResult = z.object({
  outcome: ResolveOutcome,
  reply: z.string().max(NOTES_CHECK_LIMITS.speechChars),
  status: FindingStatus,
});
export type ResolveResult = z.infer<typeof ResolveResult>;

export const ExplainOutput = z.object({ explanation: z.string().max(800) });
export const ExplainResult = z.object({
  explanation: z.string().max(NOTES_CHECK_LIMITS.speechChars),
  status: FindingStatus,
});
export type ExplainResult = z.infer<typeof ExplainResult>;

export const GapHeadingOutput = z.object({ heading: z.string().max(120) });
export const GapHeadingResult = z.object({ heading: z.string().max(60) });
export type GapHeadingResult = z.infer<typeof GapHeadingResult>;

/** The course concept a finding is about: the one whose title shares the most of its words. */
export function matchConcept(
  hint: string | null,
  concepts: readonly { id: string; title: string }[],
): string | null {
  const words = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !["the", "and", "for", "with"].includes(w)),
    );
  const wanted = words(hint ?? "");
  if (wanted.size === 0) return null;
  let best: { id: string; score: number } | null = null;
  for (const concept of concepts) {
    const have = words(concept.title);
    const shared = [...wanted].filter((w) => have.has(w)).length;
    const score = shared / new Set([...wanted, ...have]).size;
    if (score >= 0.5 && (!best || score > best.score)) best = { id: concept.id, score };
  }
  return best?.id ?? null;
}
