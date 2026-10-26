import { type ImageBlock, type Notebook, NotebookTree, type Page, type Stroke } from "@mew/shared";
import Dexie, { type EntityTable } from "dexie";

import type { LocalNoteLine } from "../notes/local-lines";

/**
 * A notebook-tree change waiting to reach the server (K1): a node to send ("node", its current
 * state is read when sending) or a node purged from the trash ("removed"). Keyed by node id, so
 * a node is queued once however often it changes.
 */
export type TreeOutboxEntry = {
  id: string;
  kind: "node" | "removed";
  /** Times the server refused it without a copy of its own (it's dropped after a few). */
  failures: number;
};

/**
 * A drawn PDF page kept on this device (K4, decision 9): its picture and text layer, as viewed
 * (or downloaded by "Make available offline"), dropped least recently used first past the cache's
 * size.
 */
export type CachedPdfPage = {
  /** `${pdfId}:${pageIndex}` */
  key: string;
  pdfId: string;
  pageIndex: number;
  image: Blob;
  text: string;
  bytes: number;
  usedAt: number;
};

/** An imported PDF this device knows (K4): to show it, and to keep it offline. */
export type LocalPdf = {
  pdfId: string;
  fileName: string;
  pageCount: number;
  /** "Make available offline" was asked for. */
  offline: boolean;
};

/** Local-first notebook storage (IndexedDB). One database per user, so accounts never mix. */
export class NotebookDb extends Dexie {
  /** The notebook tree: notebooks, chapters and sections (K1). */
  notebooks!: EntityTable<Notebook, "id">;
  pages!: EntityTable<Page, "id">;
  strokes!: EntityTable<Stroke, "id">;
  /** Images on pages: clips saved from the screen (Screen Coach S3). */
  images!: EntityTable<ImageBlock, "id">;
  /** Each page's lines with their recognised text and sync state (Notes Check N1). */
  noteLines!: EntityTable<LocalNoteLine, "id">;
  /** Tree changes not on the server yet (K1). */
  treeOutbox!: EntityTable<TreeOutboxEntry, "id">;
  /** PDF pages drawn and kept for offline use (K4). */
  pdfPages!: EntityTable<CachedPdfPage, "key">;
  pdfs!: EntityTable<LocalPdf, "pdfId">;

  constructor(userId: string) {
    super(databaseName(userId));
    this.version(1).stores({
      notebooks: "id, updatedAt",
      pages: "id, notebookId, [notebookId+index]",
      strokes: "id, pageId",
    });
    this.version(2).stores({ images: "id, pageId, clipId" });
    this.version(3).stores({ noteLines: "id, pageId" });
    this.version(4)
      .stores({ notebooks: "id, updatedAt, parentId", treeOutbox: "id" })
      .upgrade(async (tx) => {
        // Every notebook so far becomes a root, in the order it was made, with a unique name
        // (the server enforces that too), and is queued for the server.
        const rows = (await tx.table("notebooks").toArray()) as Notebook[];
        rows.sort((a, b) => a.createdAt - b.createdAt);
        const positions = new NotebookTree<Notebook>([]).positionsAtEnd(null, rows.length);
        const placed: Notebook[] = [];
        rows.forEach((row, i) => {
          const title = new NotebookTree(placed).freeName(null, row.title);
          placed.push({
            ...row,
            title,
            parentId: null,
            position: positions[i] ?? "a0",
            childLabel: "Chapters",
            editedAt: row.updatedAt,
          });
        });
        await tx.table("notebooks").bulkPut(placed);
        await tx
          .table("treeOutbox")
          .bulkPut(placed.map((n) => ({ id: n.id, kind: "node", failures: 0 })));
      });
    this.version(5).stores({ pdfPages: "key, pdfId, usedAt", pdfs: "pdfId" });
  }
}

export function databaseName(userId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error("Invalid user id for local storage");
  return `mew-notebooks-${userId}`;
}
