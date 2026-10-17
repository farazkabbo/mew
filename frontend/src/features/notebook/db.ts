import type { Notebook, Page, Stroke } from "@mew/shared";
import Dexie, { type EntityTable } from "dexie";

/** Local-first notebook storage (IndexedDB). One database per user, so accounts never mix. */
export class NotebookDb extends Dexie {
  notebooks!: EntityTable<Notebook, "id">;
  pages!: EntityTable<Page, "id">;
  strokes!: EntityTable<Stroke, "id">;

  constructor(userId: string) {
    super(databaseName(userId));
    this.version(1).stores({
      notebooks: "id, updatedAt",
      pages: "id, notebookId, [notebookId+index]",
      strokes: "id, pageId",
    });
  }
}

export function databaseName(userId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error("Invalid user id for local storage");
  return `mew-notebooks-${userId}`;
}
