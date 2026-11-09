import "server-only";

import { asksToDoIt, type NoteExcerpt, type NotebookEvent, STUDENT_NOTES_MAX } from "@mew/shared";

/** One of the student's lines that matched, with where it is (kept here; the model sees less). */
export type StudentNote = NoteExcerpt & Omit<NotebookEvent, "type" | "open" | "page">;

/**
 * The student's own lines that match a screen question (docs/PLAN.md, "teach from your notes"),
 * found by Notes Check's search over their notebooks (the device's token: only its owner's).
 * Nothing when the question is too short or the search fails: the answer goes on without them.
 */
export async function studentNotes(token: string, words: string): Promise<StudentNote[]> {
  const text = words.trim().slice(0, 400);
  if (text.split(/\s+/).length < 2) return [];
  try {
    // Loaded here: the answer modules import this file for its pure helpers only.
    const { retrieveNotes } = await import("./notes-check/api");
    const found = await retrieveNotes({ kind: "device", token }, [{ blockId: "q", text }], {
      kind: "all",
    });
    const pages = new Map(found.pages.map((p) => [p.pageId, p]));
    return found.lines
      .filter((line) => line.hit && line.text.trim().length > 0 && pages.has(line.pageId))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, STUDENT_NOTES_MAX)
      .flatMap((line, i) => {
        const page = pages.get(line.pageId);
        if (!page) return [];
        return [
          {
            ref: i + 1,
            notebook: page.notebookTitle.slice(0, 200),
            page: page.pageIndex + 1,
            text: line.text.slice(0, 300),
            notebookId: page.notebookId,
            notebookTitle: page.notebookTitle.slice(0, 200),
            pageId: line.pageId,
            lineIndex: line.lineIndex,
            bbox: line.bbox,
          },
        ];
      });
  } catch {
    return [];
  }
}

/** What the model sees of the student's lines: words and where, no ids. */
export function excerpts(notes: readonly StudentNote[]): NoteExcerpt[] {
  return notes.map(({ ref, notebook, page, text }) => ({ ref, notebook, page, text }));
}

/** The event for the line the answer taught from, if it named one we gave it. */
export function notebookEvent(
  notes: readonly StudentNote[],
  ref: number | null | undefined,
  question: string,
): NotebookEvent | null {
  const note = ref ? notes.find((n) => n.ref === ref) : undefined;
  if (!note) return null;
  return {
    type: "notebook",
    notebookId: note.notebookId,
    pageId: note.pageId,
    lineIndex: note.lineIndex,
    bbox: note.bbox,
    notebookTitle: note.notebookTitle,
    page: note.page,
    open: asksToDoIt(question),
  };
}
