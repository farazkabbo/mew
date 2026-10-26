import {
  type ClipView,
  type DestinationPage,
  ImageBlock,
  Notebook,
  NotebookTree,
  Page,
  Stroke,
} from "@mew/shared";
import Dexie from "dexie";
import type { z } from "zod";

import {
  clipToPage,
  IMAGE_ORIGIN,
  MAX_IMAGE_WIDTH,
  dayHeading,
  ENTRIES_PER_PAGE,
  entryFollowUps,
  entryStrokeIds,
  entryToPage,
  nextEntryTop,
  startsNewDay,
} from "./clip-page";
import type { NotebookDb } from "./db";
import { PdfPageCache } from "../pdfs/page-cache";
import { newPage } from "./page-factory";
import { TreeRepository } from "./tree-repository";

/**
 * Data access for notebooks, pages and strokes. Everything read back is schema-validated. The
 * notebook tree's structure (making, renaming, moving, trash, sync) is `tree`'s.
 */
export class NotebookRepository {
  readonly tree: TreeRepository;
  /** PDF pages kept on this device (K4). */
  readonly pdfCache: PdfPageCache;

  constructor(private readonly db: NotebookDb) {
    this.tree = new TreeRepository(db);
    this.pdfCache = new PdfPageCache(db);
  }

  /** BroadcastChannel name shared by tabs editing this user's notebooks. */
  get syncChannelName(): string {
    return `${this.db.name}:sync`;
  }

  /**
   * Notebooks, chapters and sections that aren't in the trash, most recently used first. A
   * Dexie promise chain, so it's safe inside a transaction (see `TreeRepository.nodes`).
   */
  listNotebooks(): Promise<Notebook[]> {
    return this.tree.nodes().then((nodes) => {
      const tree = new NotebookTree(nodes);
      return nodes.filter((n) => tree.isLive(n.id)).sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }

  /**
   * The most recently used node, creating a first notebook if there are none. Check-and-create
   * runs in one read-write transaction, which IndexedDB serialises, so concurrent callers (React
   * StrictMode, two tabs) can never create duplicates.
   */
  async openLatestNotebook(): Promise<Notebook> {
    return this.tree.write(async () => {
      const [latest] = await this.listNotebooks();
      return latest ?? (await this.tree.createNotebook({ title: "My first notebook" }));
    });
  }

  /** The notebook for a course, creating it on first use (in one transaction: no duplicates). */
  async notebookForCourse(courseId: string, title: string): Promise<Notebook> {
    return this.tree.write(async () => {
      const existing = (await this.listNotebooks()).find(
        (n) => n.courseId === courseId && n.parentId === null,
      );
      return existing ?? (await this.tree.createNotebook({ title, courseId }));
    });
  }

  /** The root a node belongs to (itself for a notebook): its course and label apply below it. */
  async rootOf(id: string): Promise<Notebook | null> {
    return (await this.tree.tree()).path(id)[0] ?? null;
  }

  async getNotebook(id: string): Promise<Notebook | null> {
    const row = await this.db.notebooks.get(id);
    return row ? (validRows(Notebook, [row], "notebook")[0] ?? null) : null;
  }

  async getPage(id: string): Promise<Page | null> {
    const row = await this.db.pages.get(id);
    return row ? (validRows(Page, [row], "page")[0] ?? null) : null;
  }

  async touchNotebook(id: string): Promise<void> {
    await this.db.notebooks.update(id, { updatedAt: Date.now() });
  }

  /** How many pages each node has. */
  async countPages(notebookIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map(notebookIds.map((id) => [id, 0]));
    await this.db.pages
      .where("notebookId")
      .anyOf([...notebookIds])
      .each((page) => counts.set(page.notebookId, (counts.get(page.notebookId) ?? 0) + 1));
    return counts;
  }

  async listPages(notebookId: string): Promise<Page[]> {
    const rows = await this.db.pages
      .where("[notebookId+index]")
      .between([notebookId, Dexie.minKey], [notebookId, Dexie.maxKey])
      .toArray();
    return validRows(Page, rows, "page");
  }

  /** Every page of every node (the jump palette lists them). */
  async listAllPages(): Promise<Page[]> {
    return validRows(Page, await this.db.pages.toArray(), "page");
  }

  /**
   * The node's first page, or a new one when it has none (a chapter made on another device:
   * pages stay on the device they were written on). In one transaction: never two.
   */
  async firstPageOrNew(notebookId: string): Promise<Page> {
    return this.db.transaction("rw", this.db.pages, async () => {
      const [first] = await this.listPages(notebookId);
      return first ?? (await this.addPage(notebookId));
    });
  }

  async addPage(notebookId: string, extra: Partial<Pick<Page, "fromScreen">> = {}): Promise<Page> {
    return this.db.transaction("rw", this.db.pages, async () => {
      const pages = await this.db.pages.where("notebookId").equals(notebookId).toArray();
      const page: Page = {
        ...newPage(
          notebookId,
          pages.reduce((max, p) => Math.max(max, p.index + 1), 0),
        ),
        ...extra,
      };
      await this.db.pages.add(page);
      return page;
    });
  }

  /**
   * Moves a page to another node (K3: "save it to Physics chapter 5", or the page picker), last
   * there unless `index` says where. It's an ordinary page there (no longer a "From screen" one).
   * Returns where it was, for Undo; null when there's no such page.
   */
  async movePage(
    pageId: string,
    notebookId: string,
    index?: number,
  ): Promise<{ page: Page; from: { notebookId: string; index: number } } | null> {
    return this.db.transaction("rw", this.db.pages, async () => {
      const row = await this.db.pages.get(pageId);
      const page = row ? Page.safeParse(row).data : undefined;
      if (!page) return null;
      const there = await this.db.pages.where("notebookId").equals(notebookId).toArray();
      const end = there.reduce((max, p) => Math.max(max, p.index + 1), 0);
      const free = index !== undefined && !there.some((p) => p.index === index);
      const moved: Page = {
        id: page.id,
        notebookId,
        index: free ? index : end,
        background: page.background,
        createdAt: page.createdAt,
      };
      await this.db.pages.put(moved);
      return { page: moved, from: { notebookId: page.notebookId, index: page.index } };
    });
  }

  /**
   * A PDF's pages `first`…`last` (1-based) as new pages at the end of `notebookId` (K4 §5.1):
   * each with the PDF page as its locked picture, as wide as a clip can be, at the PDF page's
   * own proportions. In one transaction. Returns the pages, in order.
   */
  async addPdfPages(
    notebookId: string,
    pdf: {
      pdfId: string;
      fileName: string;
      pageCount: number;
      sizes: readonly (readonly [number, number])[];
    },
    first: number,
    last: number,
  ): Promise<Page[]> {
    const now = Date.now();
    return this.db.transaction("rw", [this.db.pages, this.db.images, this.db.pdfs], async () => {
      await this.db.pdfs.put({
        pdfId: pdf.pdfId,
        fileName: pdf.fileName,
        pageCount: pdf.pageCount,
        offline: (await this.db.pdfs.get(pdf.pdfId))?.offline ?? false,
      });
      const there = await this.db.pages.where("notebookId").equals(notebookId).toArray();
      let index = there.reduce((max, p) => Math.max(max, p.index + 1), 0);
      const pages: Page[] = [];
      const images: ImageBlock[] = [];
      for (let number = first; number <= last; number++) {
        const page = newPage(notebookId, index++);
        const [w, h] = pdf.sizes[number - 1] ?? [612, 792];
        const width = MAX_IMAGE_WIDTH;
        images.push(
          ImageBlock.parse({
            id: crypto.randomUUID(),
            pageId: page.id,
            type: "image",
            pdf: { pdfId: pdf.pdfId, pageIndex: number - 1 },
            x: IMAGE_ORIGIN[0],
            y: IMAGE_ORIGIN[1],
            width,
            height: Math.min(10_000, (width * h) / Math.max(w, 1)),
            source: {
              app: "neb",
              title: `${pdf.fileName} · page ${number}`.slice(0, 200),
              capturedAt: new Date(now).toISOString(),
            },
            createdAt: now,
          }),
        );
        pages.push(page);
      }
      await this.db.pages.bulkAdd(pages);
      await this.db.images.bulkAdd(images);
      return pages;
    });
  }

  /**
   * The PDF pages under a node and its chapters (for "Make available offline", K4): each PDF and
   * the page indexes of it there.
   */
  async pdfPagesUnder(nodeIds: readonly string[]): Promise<Map<string, number[]>> {
    const pages = await this.db.pages
      .where("notebookId")
      .anyOf([...nodeIds])
      .primaryKeys();
    const images = await this.db.images.where("pageId").anyOf(pages).toArray();
    const byPdf = new Map<string, number[]>();
    for (const image of images) {
      if (!image.pdf) continue;
      byPdf.set(image.pdf.pdfId, [...(byPdf.get(image.pdf.pdfId) ?? []), image.pdf.pageIndex]);
    }
    return byPdf;
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

  /** A PDF page's text, kept with its picture block once read (the tutor's context, K4). */
  async setImageText(imageId: string, text: string): Promise<void> {
    await this.db.images.update(imageId, { ocrText: text.slice(0, 8_000) });
  }

  async loadImages(pageId: string): Promise<ImageBlock[]> {
    const rows = await this.db.images.where("pageId").equals(pageId).toArray();
    return validRows(ImageBlock, rows, "image").sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Where a clip saved from the screen goes (K3): the node the student named (made first, after
   * "Create it and save", unless one with that title is already there), or `fallback` (the node
   * open in the notebook) when they named none or it isn't on this device. `missing` says the
   * named one wasn't found.
   */
  async destinationOf(
    clip: ClipView,
    fallback: string,
  ): Promise<{ nodeId: string; page: DestinationPage; missing: boolean }> {
    const destination = clip.destination;
    const fromScreen: DestinationPage = { kind: "from_screen" };
    if (!destination) return { nodeId: fallback, page: fromScreen, missing: false };
    const tree = await this.tree.tree();
    const live = (id: string) => tree.get(id) !== undefined && tree.isLive(id);
    if (!live(destination.nodeId)) return { nodeId: fallback, page: fromScreen, missing: true };
    const create = destination.create;
    if (!create) return { nodeId: destination.nodeId, page: destination.page, missing: false };
    const title = create.title.toLowerCase();
    const there = tree
      .children(destination.nodeId)
      .find((child) => child.title.toLowerCase() === title);
    const child = there ?? (await this.tree.addChild(destination.nodeId, create.title));
    return child
      ? { nodeId: child.id, page: destination.page, missing: false }
      : { nodeId: destination.nodeId, page: destination.page, missing: false };
  }

  /**
   * A new page for a clip saved from the screen, at the end of its node: the image and the
   * tutor's annotations as ink. In one transaction, and only once per clip (a second tab or a
   * repeated event gets the page already made).
   */
  async importClip(notebookId: string, clip: ClipView): Promise<Page> {
    return this.db.transaction(
      "rw",
      [this.db.pages, this.db.images, this.db.strokes, this.db.notebooks],
      async () => {
        const existing = await this.db.images.where("clipId").equals(clip.id).first();
        const existingPage = existing && (await this.db.pages.get(existing.pageId));
        if (existingPage) return Page.parse(existingPage);

        const page = await this.addPage(notebookId);
        const { image, strokes } = clipToPage(clip, page.id, {
          now: Date.now(),
          newId: () => crypto.randomUUID(),
        });
        await this.db.images.add(ImageBlock.parse(image));
        await this.db.strokes.bulkAdd(strokes.map((s) => Stroke.parse(s)));
        await this.touchNotebook(notebookId);
        return page;
      },
    );
  }

  /**
   * Adds a Circle & Ask entry (S3.2 §2.5) to a page of `notebookId` (K3: its "From screen" page,
   * a new page, or its nth page), below the entries already there, under a date heading when the
   * day changed. An entry already on a page of that node is brought up to date instead (a
   * follow-up's turns and strokes are added); one on another node's page moves here whole (the
   * student changed where it goes: never two copies). Returns its page.
   */
  async importEntry(
    notebookId: string,
    clip: ClipView,
    target: DestinationPage = { kind: "from_screen" },
  ): Promise<Page> {
    const ids = { now: Date.now(), newId: () => crypto.randomUUID() };
    return this.db.transaction(
      "rw",
      [this.db.pages, this.db.images, this.db.strokes, this.db.notebooks],
      async () => {
        const existing = await this.db.images.where("clipId").equals(clip.id).first();
        const existingPage = existing && (await this.db.pages.get(existing.pageId));
        if (existing && existingPage && existingPage.notebookId === notebookId) {
          const followUps = entryFollowUps(clip, ImageBlock.parse(existing), ids);
          if (followUps) {
            await this.db.images.put(ImageBlock.parse(followUps.image));
            await this.db.strokes.bulkAdd(followUps.strokes.map((s) => Stroke.parse(s)));
            await this.touchNotebook(notebookId);
          }
          return Page.parse(existingPage);
        }
        if (existing) {
          // Moved: off the old page, whole, before it's laid out on the new one.
          const block = ImageBlock.parse(existing);
          const onPage = await this.db.strokes.where("pageId").equals(block.pageId).toArray();
          await this.db.strokes.bulkDelete(
            entryStrokeIds(block, validRows(Stroke, onPage, "stroke")),
          );
          await this.db.images.delete(block.id);
        }

        const page = await this.entryPage(notebookId, target);
        const above = await this.db.images.where("pageId").equals(page.id).toArray();
        const placed = validRows(ImageBlock, above, "image");
        const now = new Date(ids.now);
        const heading = startsNewDay(placed, now) ? dayHeading(now) : undefined;
        const { image, strokes } = entryToPage(clip, page.id, nextEntryTop(placed), ids, heading);
        await this.db.images.add(ImageBlock.parse(image));
        await this.db.strokes.bulkAdd(strokes.map((s) => Stroke.parse(s)));
        await this.touchNotebook(notebookId);
        return Page.parse(page);
      },
    );
  }

  /**
   * The page an entry goes on: the node's "From screen" page (one per node; after about 30
   * entries the next one starts, decision 7), a new page, or its nth page (a new one when it has
   * fewer). Runs inside `importEntry`'s transaction.
   */
  private async entryPage(notebookId: string, target: DestinationPage): Promise<Page> {
    if (target.kind === "new") return this.addPage(notebookId);
    const pages = validRows(
      Page,
      await this.db.pages.where("notebookId").equals(notebookId).toArray(),
      "page",
    ).sort((a, b) => a.index - b.index);
    if (target.kind === "number") return pages[target.number - 1] ?? this.addPage(notebookId);
    const latest = pages
      .filter((p) => p.fromScreen !== undefined)
      .sort((a, b) => (b.fromScreen ?? 0) - (a.fromScreen ?? 0))[0];
    if (latest) {
      const entries = await this.db.images
        .where("pageId")
        .equals(latest.id)
        .filter((image) => image.entry !== undefined)
        .count();
      if (entries < ENTRIES_PER_PAGE) return latest;
    }
    return this.addPage(notebookId, { fromScreen: (latest?.fromScreen ?? 0) + 1 });
  }
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
