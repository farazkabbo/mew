import {
  BBox,
  ContentHash,
  NoteLineSource,
  type NoteLineUpsert,
  NOTES_LIMITS,
  Recognition,
} from "@mew/shared";
import { z } from "zod";

import type { NotebookDb } from "../notebook/db";

/**
 * One line of a notebook page as this device knows it (Notes Check N1): which strokes make it
 * up, its recognised text, and what the server has of it. The device is the source of truth;
 * the server gets a copy of the text (docs/SCREEN_COACH_NOTES_CHECK.md, decisions 1, 5 and 6).
 */
export const LocalNoteLine = z.object({
  /** Lasting id, kept while the line still holds most of its strokes (`assignLineIds`). */
  id: z.uuid(),
  pageId: z.uuid(),
  source: NoteLineSource,
  /** Ink lines: the strokes the line had when last seen. */
  strokeIds: z.array(z.string()).max(5_000),
  /** Clip lines: the clip, and which of its text lines this is. */
  clipId: z.uuid().optional(),
  clipLine: z.number().int().nonnegative().optional(),
  bbox: BBox,
  lineIndex: z.number().int().min(0).max(NOTES_LIMITS.lineIndex),
  contentHash: ContentHash,
  /** null until recognised, and again after the line's strokes change. */
  recognition: Recognition.nullable(),
  /** `syncKey` of what the server has for this line ("" for nothing). */
  synced: z.string(),
  /** Gone from the page; kept until the server has dropped it too. */
  removed: z.boolean(),
});
export type LocalNoteLine = z.infer<typeof LocalNoteLine>;

/**
 * What the server should have for a line, as a comparable string: "" when it should have
 * nothing (the line is gone, not recognised yet, or recognised as blank). A line needs syncing
 * exactly when this differs from its `synced`.
 */
export function syncKey(line: LocalNoteLine): string {
  const upsert = toUpsert(line);
  return upsert ? JSON.stringify(upsert) : "";
}

/** The line as the server stores it, or null when the server should have nothing for it. */
export function toUpsert(line: LocalNoteLine): NoteLineUpsert | null {
  const text = line.recognition?.text ?? "";
  if (line.removed || !line.recognition || text === "") return null;
  return {
    id: line.id,
    lineIndex: line.lineIndex,
    bbox: line.bbox.map((v) => Math.round(v * 10) / 10) as BBox,
    source: line.source,
    ...(line.clipId && { clipId: line.clipId }),
    text,
    latex: line.recognition.latex?.trim() || null,
    confidence: line.recognition.confidence,
    contentHash: line.contentHash,
  };
}

/** Recognised or clipped text as one clean line: no control characters, within the limit. */
export function cleanLineText(text: string, max: number = NOTES_LIMITS.textChars): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** Line records in IndexedDB. Everything read back is validated: local data is never trusted. */
export class LocalNoteLines {
  constructor(private readonly db: NotebookDb) {}

  /** The record of one line (wherever its page is), or null. */
  async get(id: string): Promise<LocalNoteLine | null> {
    const row = await this.db.noteLines.get(id);
    return row ? (valid([row])[0] ?? null) : null;
  }

  async forPage(pageId: string): Promise<LocalNoteLine[]> {
    return valid(await this.db.noteLines.where("pageId").equals(pageId).toArray());
  }

  /** Pages with lines the server doesn't have in their latest form. */
  async pagesToSync(): Promise<string[]> {
    const pages = new Set<string>();
    await this.db.noteLines.each((row) => {
      const line = LocalNoteLine.safeParse(row);
      if (line.success && syncKey(line.data) !== line.data.synced) pages.add(line.data.pageId);
    });
    return [...pages];
  }

  /**
   * Runs `fn` in one read-write transaction over the line records, so two tabs indexing the
   * same page can't interleave their reads and writes.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.transaction("rw", this.db.noteLines, fn);
  }

  async put(lines: readonly LocalNoteLine[]): Promise<void> {
    if (lines.length > 0) await this.db.noteLines.bulkPut(lines.map((l) => LocalNoteLine.parse(l)));
  }

  async delete(ids: readonly string[]): Promise<void> {
    if (ids.length > 0) await this.db.noteLines.bulkDelete([...ids]);
  }

  /** The server copy was deleted (the setting went off): nothing counts as synced any more. */
  async forgetSynced(): Promise<void> {
    await this.transaction(async () => {
      await this.db.noteLines
        .filter((row) => (row as LocalNoteLine).synced !== "")
        .modify({ synced: "" });
      await this.db.noteLines.filter((row) => (row as LocalNoteLine).removed === true).delete();
    });
  }
}

function valid(rows: readonly unknown[]): LocalNoteLine[] {
  const lines: LocalNoteLine[] = [];
  for (const row of rows) {
    const parsed = LocalNoteLine.safeParse(row);
    if (parsed.success) lines.push(parsed.data);
  }
  return lines;
}
