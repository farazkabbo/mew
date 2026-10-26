import { Annotation, type Recognition, Stroke, toAnnotationUpsert } from "@mew/shared";

import type { NotebookDb } from "../notebook/db";
import { LocalNoteLine } from "../notes/local-lines";

/**
 * Live annotations as this device keeps them (K9 §7.3, Dexie v7 `annotations`): each mark's
 * record next to its strokes. A mark, its strokes, the strokes of the mark it replaces and the
 * line's recognition are written in one transaction: nothing is ever half saved, and there's no
 * save button. Everything read back is validated (local data is never trusted).
 */
export class AnnotationRecords {
  constructor(private readonly db: NotebookDb) {}

  async forPage(pageId: string): Promise<Annotation[]> {
    const rows = await this.db.annotations.where("pageId").equals(pageId).toArray();
    return rows.flatMap((row) => {
      const parsed = Annotation.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  }

  /**
   * A line's mark changed: `put` records (the new mark, the one it replaces), its strokes on the
   * page, the strokes taken off, and (when the line has a Notes Check record) what it was read as.
   */
  async save(change: {
    put: readonly Annotation[];
    addStrokes: readonly Stroke[];
    removeStrokeIds: readonly string[];
    reading?: { lineId: string; recognition: Recognition } | undefined;
  }): Promise<void> {
    const db = this.db;
    await db.transaction("rw", [db.annotations, db.strokes, db.noteLines], async () => {
      if (change.removeStrokeIds.length > 0)
        await db.strokes.bulkDelete([...change.removeStrokeIds]);
      if (change.addStrokes.length > 0)
        await db.strokes.bulkPut(change.addStrokes.map((s) => Stroke.parse(s)));
      if (change.put.length > 0)
        await db.annotations.bulkPut(change.put.map((a) => Annotation.parse(a)));
      if (change.reading) {
        const row = LocalNoteLine.safeParse(await db.noteLines.get(change.reading.lineId));
        if (row.success && row.data.recognition === null) {
          await db.noteLines.put({ ...row.data, recognition: change.reading.recognition });
        }
      }
    });
  }

  /** The Notes Check line holding at least half of these strokes, if this page has one. */
  async noteLineId(pageId: string, strokeIds: readonly string[]): Promise<string | null> {
    const wanted = new Set(strokeIds);
    const rows = await this.db.noteLines.where("pageId").equals(pageId).toArray();
    let best: { id: string; shared: number } | null = null;
    for (const row of rows) {
      const line = LocalNoteLine.safeParse(row);
      if (!line.success || line.data.removed || line.data.source !== "ink") continue;
      const shared = line.data.strokeIds.filter((id) => wanted.has(id)).length;
      if (shared * 2 >= line.data.strokeIds.length && shared > (best?.shared ?? 0)) {
        best = { id: line.data.id, shared };
      }
    }
    return best?.id ?? null;
  }

  /** Marks the server doesn't have in their latest version yet (oldest first). */
  async unsynced(limit: number): Promise<Annotation[]> {
    const rows = await this.db.annotations
      .filter((a) => a.synced === false)
      .limit(limit)
      .toArray();
    return rows
      .flatMap((row) => {
        const parsed = Annotation.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** The server has these versions (a mark changed meanwhile stays unsynced). */
  async markSynced(sent: readonly Annotation[]): Promise<void> {
    const db = this.db;
    await db.transaction("rw", db.annotations, async () => {
      for (const annotation of sent) {
        const now = await db.annotations.get(annotation.id);
        const same = (a: Annotation) => JSON.stringify(toAnnotationUpsert(a, true));
        const current = Annotation.safeParse(now);
        if (current.success && same(current.data) === same(annotation)) {
          await db.annotations.update(annotation.id, { synced: true });
        }
      }
    });
  }
}
