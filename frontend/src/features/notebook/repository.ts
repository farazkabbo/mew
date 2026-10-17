import { Notebook, Page, Stroke } from "@mew/shared";
import Dexie from "dexie";
import type { z } from "zod";

import type { NotebookDb } from "./db";

/** Data access for notebooks, pages and strokes. Everything read back is schema-validated. */
export class NotebookRepository {
  constructor(private readonly db: NotebookDb) {}

  /** BroadcastChannel name shared by tabs editing this user's notebooks. */
  get syncChannelName(): string {
    return `${this.db.name}:sync`;
  }

  async listNotebooks(): Promise<Notebook[]> {
    const rows = await this.db.notebooks.orderBy("updatedAt").reverse().toArray();
    return validRows(Notebook, rows, "notebook");
  }

  /**
   * The most recently used notebook, creating a first one if there are none. Check-and-create
   * runs in one read-write transaction, which IndexedDB serialises, so concurrent callers (React
   * StrictMode, two tabs) can never create duplicates.
   */
  async openLatestNotebook(): Promise<Notebook> {
    return this.db.transaction("rw", this.db.notebooks, this.db.pages, async () => {
      const [latest] = await this.listNotebooks();
      return latest ?? (await this.createNotebook("My first notebook"));
    });
  }

  async createNotebook(title: string): Promise<Notebook> {
    const now = Date.now();
    const notebook = Notebook.parse({
      id: crypto.randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
    });
    // Joins the caller's transaction when there is one (see openLatestNotebook).
    await this.db.transaction("rw", this.db.notebooks, this.db.pages, async () => {
      await this.db.notebooks.add(notebook);
      await this.db.pages.add(newPage(notebook.id, 0));
    });
    return notebook;
  }

  async touchNotebook(id: string): Promise<void> {
    await this.db.notebooks.update(id, { updatedAt: Date.now() });
  }

  async listPages(notebookId: string): Promise<Page[]> {
    const rows = await this.db.pages
      .where("[notebookId+index]")
      .between([notebookId, Dexie.minKey], [notebookId, Dexie.maxKey])
      .toArray();
    return validRows(Page, rows, "page");
  }

  async addPage(notebookId: string): Promise<Page> {
    return this.db.transaction("rw", this.db.pages, async () => {
      const pages = await this.db.pages.where("notebookId").equals(notebookId).toArray();
      const page = newPage(
        notebookId,
        pages.reduce((max, p) => Math.max(max, p.index + 1), 0),
      );
      await this.db.pages.add(page);
      return page;
    });
  }

  async loadStrokes(pageId: string): Promise<Stroke[]> {
    const rows = await this.db.strokes.where("pageId").equals(pageId).toArray();
    return validRows(Stroke, rows, "stroke").sort((a, b) => a.createdAt - b.createdAt);
  }

  async putStrokes(strokes: readonly Stroke[]): Promise<void> {
    if (strokes.length > 0) await this.db.strokes.bulkPut([...strokes]);
  }

  async deleteStrokes(ids: readonly string[]): Promise<void> {
    if (ids.length > 0) await this.db.strokes.bulkDelete([...ids]);
  }
}

function newPage(notebookId: string, index: number): Page {
  return {
    id: crypto.randomUUID(),
    notebookId,
    index,
    background: "dot_grid",
    createdAt: Date.now(),
  };
}

/** Keeps rows that match the schema; corrupted local data is skipped, never trusted. */
function validRows<T>(schema: z.ZodType<T>, rows: readonly unknown[], label: string): T[] {
  const valid: T[] = [];
  let skipped = 0;
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) valid.push(parsed.data);
    else skipped++;
  }
  if (skipped > 0) console.warn(`[notebook] skipped ${skipped} invalid ${label} row(s)`);
  return valid;
}
