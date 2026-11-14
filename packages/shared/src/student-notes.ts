import { z } from "zod";

import { BBox } from "./notebook";

/**
 * Teaching from the student's own notebook (docs/PLAN.md, "teach from your notes"): when a screen
 * question matches lines the student wrote, those lines go with it, and an answer built on one
 * says where it is. When the student asked neb to do the work for them, the notebook opens at
 * that page and the pointer shows the line: neb helps them learn it, it doesn't do it for them.
 */

/** At most this many of the student's lines go with a question. */
export const STUDENT_NOTES_MAX = 4;

/** One of the student's lines, as the model sees it (`ref` is how it names it back). */
export const NoteExcerpt = z.object({
  ref: z.number().int().min(1).max(STUDENT_NOTES_MAX),
  notebook: z.string().max(200),
  page: z.number().int().min(1).max(10_000),
  text: z.string().max(300),
});
export type NoteExcerpt = z.infer<typeof NoteExcerpt>;

/** The model's answer names the line it taught from (its `ref`), when it used one. */
export const FromNotes = z.number().int().min(1).max(STUDENT_NOTES_MAX).nullable().optional();

/** "It's in your notes": where, and whether to open the notebook there (a do-it-for-me). */
export const NotebookEvent = z.object({
  type: z.literal("notebook"),
  notebookId: z.uuid(),
  pageId: z.uuid(),
  lineIndex: z.number().int().min(0),
  /** The line on its page, in page units (the pointer goes there). */
  bbox: BBox,
  notebookTitle: z.string().max(200),
  page: z.number().int().min(1),
  /** The student asked neb to do it: the notebook opens at the line. */
  open: z.boolean(),
});
export type NotebookEvent = z.infer<typeof NotebookEvent>;

/** The rule every screen prompt carries (constant, so the prompt's prefix stays cacheable). */
export const STUDENT_NOTES_RULE = `- "studentNotes", when present, are lines from the student's own notebook that match the question. If one covers it, teach from it: say where they wrote it ("in your Physics notebook, page 3") and how it applies, and let them take the step themselves. Set "fromNotes" to that line's "ref"; leave it out otherwise. This matters most when they ask you to do the work for them: point them to their own notes and guide them; never do it for them.`;
