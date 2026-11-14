import type { PdfPageCache } from "../../pdfs/page-cache";

/**
 * The pictures on the page, kept as bitmaps while it's open: clips saved from the screen (Screen
 * Coach S3), fetched from the app's own route with the student's session (never cached by the
 * browser); and PDF pages (K4), through the device's PDF page cache (so they open offline once
 * viewed). A PDF page's text arrives with it, for the tutor (`onText`).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Entry = ImageBitmap | "loading" | "failed";

const LOAD_TRIES = 3;
const LOAD_RETRY_MS = 1_500;

export class ClipImages {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  constructor(
    /** Called when a picture has arrived (redraw). */
    private readonly onLoad: () => void,
    private readonly pdfs: Pick<PdfPageCache, "get"> | null = null,
    /** A PDF page's text layer, once it's here. */
    private readonly onText: (
      pdf: { pdfId: string; pageIndex: number },
      text: string,
    ) => void = () => undefined,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly decode: (blob: Blob) => Promise<ImageBitmap> = (blob) =>
      createImageBitmap(blob),
  ) {}

  /** The picture if it's here; otherwise starts loading it and returns null. */
  get(clipId: string): ImageBitmap | null {
    const entry = this.entries.get(clipId);
    if (typeof entry === "object") return entry;
    if (entry === undefined && UUID.test(clipId)) {
      this.entries.set(clipId, "loading");
      void this.load(clipId);
    }
    return null;
  }

  /** A PDF page's picture if it's here; otherwise starts loading it and returns null. */
  getPdf(pdf: { pdfId: string; pageIndex: number }): ImageBitmap | null {
    const key = `pdf:${pdf.pdfId}:${pdf.pageIndex}`;
    const entry = this.entries.get(key);
    if (typeof entry === "object") return entry;
    if (entry === undefined && UUID.test(pdf.pdfId) && this.pdfs) {
      this.entries.set(key, "loading");
      void this.loadPdf(key, pdf, this.pdfs);
    }
    return null;
  }

  /** The picture couldn't be had (offline and never kept, or gone). */
  failed(key: string): boolean {
    return this.entries.get(key) === "failed";
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) if (typeof entry === "object") entry.close();
    this.entries.clear();
  }

  private async loadPdf(
    key: string,
    pdf: { pdfId: string; pageIndex: number },
    cache: Pick<PdfPageCache, "get">,
  ): Promise<void> {
    try {
      const page = await cache.get(pdf.pdfId, pdf.pageIndex);
      if (!page) throw new Error("not here");
      const bitmap = await this.decode(page.image);
      if (this.disposed) {
        bitmap.close();
        return;
      }
      this.entries.set(key, bitmap);
      this.onText(pdf, page.text);
      this.onLoad();
    } catch {
      if (!this.disposed) {
        this.entries.set(key, "failed");
        this.onLoad();
      }
    }
  }

  private async load(clipId: string, tries = 1): Promise<void> {
    try {
      const response = await this.fetchImpl(`/api/clips/${clipId}/image`, { cache: "no-store" });
      const blob = await response.blob();
      if (!response.ok || blob.type !== "image/jpeg") {
        throw new Error(`the answer was ${response.status} ${blob.type}`);
      }
      const bitmap = await this.decode(blob);
      if (this.disposed) {
        bitmap.close();
        return;
      }
      this.entries.set(clipId, bitmap);
      this.onLoad();
    } catch (error) {
      if (this.disposed) return;
      // Never the picture or its text: only why it didn't arrive.
      console.warn(`[notebook] a saved picture didn't load (try ${tries}):`, error);
      // Just saved, or a moment offline: worth asking again. After that the page shows a
      // placeholder until it's opened again.
      if (tries < LOAD_TRIES) {
        setTimeout(() => {
          if (!this.disposed) void this.load(clipId, tries + 1);
        }, LOAD_RETRY_MS * tries);
      } else {
        this.entries.set(clipId, "failed");
      }
    }
  }
}
