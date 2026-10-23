import { z } from "zod";

import { BBox } from "./notebook";

/**
 * Note lines (Notes Check N1, docs/SCREEN_COACH_NOTES_CHECK.md §4.1): the recognised text of
 * each line in the student's notebook, kept on the server so the tutor can find the notes that
 * relate to what's on screen. Mirrors backend/src/mew_api/notes/models.py.
 *
 * The browser owns the strokes, so it decides what a line is (and keeps its id stable); after a
 * page changes, it sends that page's changed and removed lines in one sync.
 */
export const NOTES_LIMITS = {
  textChars: 300,
  latexChars: 300,
  notebookTitleChars: 200,
  /** Lines added or changed per sync (a bigger page is sent in several). */
  linesPerSync: 200,
  removedPerSync: 1000,
  lineIndex: 10_000,
  /** Notes Check counts a line as "can't tell" below this recognition confidence (brief §6.1). */
  lowConfidence: 0.6,
} as const;

/** "ink": the student's handwriting. "clip": text read from a clip saved from the screen. */
export const NoteLineSource = z.enum(["ink", "clip"]);
export type NoteLineSource = z.infer<typeof NoteLineSource>;

/** Hex FNV-1a of the line's strokes (`lineContentHash` in @mew/ink). */
export const ContentHash = z.string().regex(/^[0-9a-f]{8}$/);

export const NoteLineUpsert = z
  .object({
    id: z.uuid(),
    /** Reading order on the page, top to bottom. */
    lineIndex: z.number().int().min(0).max(NOTES_LIMITS.lineIndex),
    bbox: BBox,
    source: NoteLineSource,
    clipId: z.uuid().optional(),
    text: z.string().trim().min(1).max(NOTES_LIMITS.textChars),
    latex: z.string().max(NOTES_LIMITS.latexChars).nullable(),
    confidence: z.number().min(0).max(1),
    contentHash: ContentHash,
  })
  .refine((line) => (line.source === "clip") === (line.clipId !== undefined), {
    message: "a clip line names its clip, and only a clip line does",
  });
export type NoteLineUpsert = z.infer<typeof NoteLineUpsert>;

/** `PUT /api/notes/pages/[pageId]/lines`: what changed on one page since the last sync. */
export const NotePageSync = z.object({
  notebook: z.object({
    id: z.uuid(),
    title: z.string().trim().min(1).max(NOTES_LIMITS.notebookTitleChars),
    courseId: z.uuid().nullable(),
  }),
  /** The page's number in its notebook (0-based). */
  pageIndex: z.number().int().min(0).max(10_000),
  upsert: z.array(NoteLineUpsert).max(NOTES_LIMITS.linesPerSync),
  /** Lines that are gone, or changed and not recognised again yet (never compared stale). */
  remove: z.array(z.uuid()).max(NOTES_LIMITS.removedPerSync),
});
export type NotePageSync = z.infer<typeof NotePageSync>;

export const NotePageSyncResult = z.object({
  /** Lines whose text was embedded again (the rest kept their embedding). */
  embedded: z.number().int().nonnegative(),
});
export type NotePageSyncResult = z.infer<typeof NotePageSyncResult>;
