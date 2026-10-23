import type { ImageBlock, Notebook, Page, Stroke } from "@mew/shared";
import Dexie, { type EntityTable } from "dexie";

/** Local-first notebook storage (IndexedDB). One database per user, so accounts never mix. */
export class NotebookDb extends Dexie {
  notebooks!: EntityTable<Notebook, "id">;
  pages!: EntityTable<Page, "id">;
  strokes!: EntityTable<Stroke, "id">;
  /** Images on pages: clips saved from the screen (Screen Coach S3). */
  images!: EntityTable<ImageBlock, "id">;

  constructor(userId: string) {
    super(databaseName(userId));
    this.version(1).stores({
      notebooks: "id, updatedAt",
      pages: "id, notebookId, [notebookId+index]",
      strokes: "id, pageId",
    });
    this.version(2).stores({ images: "id, pageId, clipId" });
  }
}

export function databaseName(userId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error("Invalid user id for local storage");
  return `mew-notebooks-${userId}`;
}
