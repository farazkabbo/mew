import { currentLine, type Line, type PageDocument, strokeGroupHash } from "@mew/ink";
import { Recognition } from "@mew/shared";

import { blobToBase64, renderStrokesPng, strokesOf, studentLines } from "../notebook/export-line";

const MAX_CACHED = 200;

/**
 * Handwriting recognition with a cache keyed by the exact strokes of a line (brief §5): a line is
 * only re-sent when it changes. Concurrent requests for the same line share one call.
 */
export class RecognitionService {
  private readonly cache = new Map<string, Recognition>();
  private readonly inflight = new Map<string, Promise<Recognition | null>>();
  /** Set when the server says recognition isn't configured, to stop retrying every pause. */
  private unavailable = false;
  /** After a 429 (our limit or the model's): no requests until then. */
  private pausedUntil = 0;

  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  /** Recognition of a line if already known (no network). */
  cached(doc: PageDocument, line: Line): Recognition | undefined {
    return this.cache.get(this.key(doc, line));
  }

  /** Text of the line written most recently, if it has been recognised. */
  currentLineText(doc: PageDocument): string | undefined {
    const line = currentLine(studentLines(doc));
    return line ? this.cached(doc, line)?.text : undefined;
  }

  async recognize(doc: PageDocument, line: Line): Promise<Recognition | null> {
    if (this.unavailable || Date.now() < this.pausedUntil) return null;
    const key = this.key(doc, line);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const request = this.request(doc, line, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }

  private async request(doc: PageDocument, line: Line, key: string): Promise<Recognition | null> {
    const raster = await renderStrokesPng(strokesOf(doc, [line]), line.bbox);
    try {
      const response = await this.fetchImpl("/api/recognize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: await blobToBase64(raster.blob) }),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 503) this.unavailable = true;
      if (response.status === 429) {
        const seconds = Number(response.headers.get("Retry-After")) || 30;
        this.pausedUntil = Date.now() + Math.min(seconds, 900) * 1000;
      }
      if (!response.ok) return null;
      const recognition = Recognition.parse(await response.json());
      this.cache.set(key, recognition);
      if (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value ?? "");
      return recognition;
    } catch {
      return null;
    }
  }

  private key(doc: PageDocument, line: Line): string {
    return strokeGroupHash(strokesOf(doc, [line]));
  }
}
