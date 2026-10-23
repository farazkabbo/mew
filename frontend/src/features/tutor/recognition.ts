import { currentLine, type Line, type PageDocument, strokeGroupHash } from "@mew/ink";
import { RECOGNIZE_BATCH_MAX, Recognition, RecognizeBatchResponse } from "@mew/shared";

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
  /** The same for batches (Notes Check), which may be refused on their own. */
  private batchUnavailable = false;
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

  /** Remembers a recognition made earlier (stored with the page), so it isn't requested again. */
  remember(doc: PageDocument, line: Line, recognition: Recognition): void {
    this.store(this.key(doc, line), recognition);
  }

  /** Whether a batch could be sent now (not paused after a 429, and configured). */
  get canBatch(): boolean {
    return !this.unavailable && !this.batchUnavailable && Date.now() >= this.pausedUntil;
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

  /**
   * Recognises several lines in one call (at most RECOGNIZE_BATCH_MAX). Lines already known are
   * answered from the cache; one result per line, in order, null where none could be made.
   */
  async recognizeMany(doc: PageDocument, lines: readonly Line[]): Promise<(Recognition | null)[]> {
    const keys = lines.map((line) => this.key(doc, line));
    const missing = lines
      .map((line, index) => ({ line, key: keys[index] ?? "" }))
      .filter(({ key }) => !this.cache.has(key))
      .slice(0, RECOGNIZE_BATCH_MAX);
    if (missing.length === 1 && missing[0]) await this.recognize(doc, missing[0].line);
    else if (missing.length > 1 && this.canBatch) await this.requestBatch(doc, missing);
    return keys.map((key) => this.cache.get(key) ?? null);
  }

  private async request(doc: PageDocument, line: Line, key: string): Promise<Recognition | null> {
    const raster = await renderStrokesPng(strokesOf(doc, [line]), line.bbox);
    try {
      const response = await this.post("/api/recognize", {
        image: await blobToBase64(raster.blob),
      });
      if (response.status === 503) this.unavailable = true;
      if (!response.ok) return null;
      const recognition = Recognition.parse(await response.json());
      this.store(key, recognition);
      return recognition;
    } catch {
      return null;
    }
  }

  private async requestBatch(
    doc: PageDocument,
    lines: readonly { line: Line; key: string }[],
  ): Promise<void> {
    try {
      const images = await Promise.all(
        lines.map(async ({ line }) => {
          const raster = await renderStrokesPng(strokesOf(doc, [line]), line.bbox);
          return blobToBase64(raster.blob);
        }),
      );
      const response = await this.post("/api/recognize/batch", { images }, 20_000);
      if (response.status === 503) this.batchUnavailable = true;
      if (!response.ok) return;
      const { lines: results } = RecognizeBatchResponse.parse(await response.json());
      results.forEach((recognition, index) => {
        const key = lines[index]?.key;
        if (recognition && key) this.store(key, recognition);
      });
    } catch {
      // Network or validation failure: the lines are tried again later.
    }
  }

  private async post(url: string, body: unknown, timeoutMs = 10_000): Promise<Response> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get("Retry-After")) || 30;
      this.pausedUntil = Date.now() + Math.min(seconds, 900) * 1000;
    }
    return response;
  }

  private store(key: string, recognition: Recognition): void {
    this.cache.set(key, recognition);
    if (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value ?? "");
  }

  private key(doc: PageDocument, line: Line): string {
    return strokeGroupHash(strokesOf(doc, [line]));
  }
}
