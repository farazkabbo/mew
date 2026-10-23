/**
 * The pictures of clips on the page (Screen Coach S3), fetched from the app's own route with the
 * student's session (never cached by the browser) and kept as bitmaps while the page is open.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Entry = ImageBitmap | "loading" | "failed";

export class ClipImages {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  constructor(
    /** Called when a picture has arrived (redraw). */
    private readonly onLoad: () => void,
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

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) if (typeof entry === "object") entry.close();
    this.entries.clear();
  }

  private async load(clipId: string): Promise<void> {
    try {
      const response = await this.fetchImpl(`/api/clips/${clipId}/image`, { cache: "no-store" });
      const blob = await response.blob();
      if (!response.ok || blob.type !== "image/jpeg") throw new Error("not an image");
      const bitmap = await this.decode(blob);
      if (this.disposed) {
        bitmap.close();
        return;
      }
      this.entries.set(clipId, bitmap);
      this.onLoad();
    } catch {
      // Offline, or the clip was deleted: the page shows a placeholder instead.
      if (!this.disposed) this.entries.set(clipId, "failed");
    }
  }
}
