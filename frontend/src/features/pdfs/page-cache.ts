import type { CachedPdfPage, NotebookDb } from "../notebook/db";

/**
 * PDF pages kept on this device (K4, decision 9): each page's picture and text layer are stored
 * as they're viewed, up to about 300 MB, the least recently used going first. "Make available
 * offline" downloads every page of a PDF (or a chapter's pages) at once. The student's own ink
 * never depends on this: it's on the device anyway.
 */

export const CACHE_BYTES = 300 * 1024 * 1024;

export type PdfPageData = { image: Blob; text: string };

type Fetcher = (url: string) => Promise<Response>;

export class PdfPageCache {
  constructor(
    private readonly db: NotebookDb,
    private readonly fetchImpl: Fetcher = (url) => fetch(url, { cache: "no-store" }),
    private readonly limit = CACHE_BYTES,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The page from this device, else from the server (then kept); null offline or on failure. */
  async get(pdfId: string, pageIndex: number): Promise<PdfPageData | null> {
    const key = `${pdfId}:${pageIndex}`;
    const cached = await this.db.pdfPages.get(key);
    if (cached) {
      await this.db.pdfPages.update(key, { usedAt: this.now() });
      return { image: cached.image, text: cached.text };
    }
    const fetched = await this.download(pdfId, pageIndex);
    if (fetched) await this.put(pdfId, pageIndex, fetched);
    return fetched;
  }

  /** Whether the page is on this device. */
  async has(pdfId: string, pageIndex: number): Promise<boolean> {
    return (await this.db.pdfPages.get(`${pdfId}:${pageIndex}`)) !== undefined;
  }

  /**
   * "Make available offline": every page in `pages` that isn't here yet, a few at a time.
   * Resolves with how many are on the device now; `onProgress` sees each one arrive.
   */
  async keep(
    pdfId: string,
    pages: readonly number[],
    onProgress: (done: number, total: number) => void = () => undefined,
  ): Promise<number> {
    let done = 0;
    const queue = [...pages];
    const worker = async () => {
      for (let page = queue.shift(); page !== undefined; page = queue.shift()) {
        if (await this.get(pdfId, page)) done++;
        onProgress(done, pages.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    await this.db.pdfs.update(pdfId, { offline: true });
    return done;
  }

  /** Bytes kept now. */
  async size(): Promise<number> {
    let total = 0;
    await this.db.pdfPages.each((page) => {
      total += page.bytes;
    });
    return total;
  }

  private async download(pdfId: string, pageIndex: number): Promise<PdfPageData | null> {
    try {
      const base = `/api/pdfs/${pdfId}/pages/${pageIndex}`;
      const [imageResponse, textResponse] = await Promise.all([
        this.fetchImpl(`${base}/image`),
        this.fetchImpl(`${base}/text`),
      ]);
      const image = await imageResponse.blob();
      if (!imageResponse.ok || image.type !== "image/png") return null;
      const body: unknown = textResponse.ok ? await textResponse.json() : null;
      const text =
        typeof body === "object" &&
        body !== null &&
        typeof (body as { text?: unknown }).text === "string"
          ? (body as { text: string }).text.slice(0, 20_000)
          : "";
      return { image, text };
    } catch {
      return null; // offline: the page shows that it needs a connection
    }
  }

  private async put(pdfId: string, pageIndex: number, data: PdfPageData): Promise<void> {
    const row: CachedPdfPage = {
      key: `${pdfId}:${pageIndex}`,
      pdfId,
      pageIndex,
      image: data.image,
      text: data.text,
      bytes: data.image.size + data.text.length * 2,
      usedAt: this.now(),
    };
    await this.db.pdfPages.put(row);
    await this.evict();
  }

  /** Least recently used first, until the cache fits again (the newest page always stays). */
  private async evict(): Promise<void> {
    let total = await this.size();
    if (total <= this.limit) return;
    const oldest = await this.db.pdfPages.orderBy("usedAt").toArray();
    const drop: string[] = [];
    for (const page of oldest.slice(0, -1)) {
      if (total <= this.limit) break;
      drop.push(page.key);
      total -= page.bytes;
    }
    await this.db.pdfPages.bulkDelete(drop);
  }
}
