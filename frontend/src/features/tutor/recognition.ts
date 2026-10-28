import {
  bytesToBase64,
  currentLine,
  type Line,
  type PageDocument,
  recognitionPng,
  strokeGroupHash,
} from "@mew/ink";
import {
  HANDWRITING_LIMITS,
  RECOGNIZE_BATCH_MAX,
  Recognition,
  type RecognitionContext,
  RecognizeBatchResponse,
  type Subject,
} from "@mew/shared";

import { strokesOf, studentLines } from "../notebook/export-line";
import { browserDeflate } from "./deflate";

/** What the page itself can't say about a line: the notebook's subject and its words (K10). */
export type ReadingContext = { subject: Subject | null; vocabulary: readonly string[] };

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

  private reading: ReadingContext = { subject: null, vocabulary: [] };

  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  /** The notebook on screen changed (K10 §8.2: its subject and chapter words help reading). */
  setReadingContext(next: ReadingContext): void {
    this.reading = next;
  }

  /**
   * A line's context (K10 §8.2): the 2 lines above it and the page's first line, as already
   * read, plus the notebook's subject and words. Lines not read yet are left out.
   */
  contextFor(doc: PageDocument, line: Line): RecognitionContext {
    const lines = studentLines(doc).sort((a, b) => a.bbox[1] - b.bbox[1]);
    const textOf = (l: Line | undefined) => {
      const known = l ? this.cached(doc, l) : undefined;
      return known && known.confidence > 0 ? clip(known.latex ?? known.text, 300) : null;
    };
    const above = lines.filter((l) => l.id !== line.id && l.bbox[1] < line.bbox[1]);
    const previous = above
      .slice(-HANDWRITING_LIMITS.previousLines)
      .map(textOf)
      .filter((t): t is string => !!t);
    const first = lines[0];
    const problem = first && first.id !== line.id ? textOf(first) : null;
    const vocabulary = [
      ...new Set(this.reading.vocabulary.map((w) => clip(w, 40)).filter(Boolean)),
    ].slice(0, HANDWRITING_LIMITS.vocabulary);
    return { previous, problem, subject: this.reading.subject, vocabulary };
  }

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

  /** How long recognition is paused for after a 429 (ms; 0 when it isn't): K9's budget. */
  get pausedForMs(): number {
    return Math.max(0, this.pausedUntil - Date.now());
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
    const image = await lineImage(doc, line);
    if (!image) return null;
    try {
      const response = await this.post("/api/recognize", {
        image,
        context: this.contextFor(doc, line),
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
      const images = await Promise.all(lines.map(({ line }) => lineImage(doc, line)));
      if (images.some((image) => !image)) return;
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

/**
 * The picture recognition reads (K10 §8.2): the line drawn from its strokes, deskewed, at a fixed
 * letter size with an even pen, on white. Null for a line without ink.
 */
export async function lineImage(doc: PageDocument, line: Line): Promise<string | null> {
  return strokesImage(strokesOf(doc, [line]));
}

/** The same picture for strokes that aren't on a page (the Quick check pad). */
export async function strokesImage(
  strokes: readonly { points: readonly (readonly number[])[] }[],
): Promise<string | null> {
  const made = await recognitionPng(strokes, browserDeflate);
  return made ? bytesToBase64(made.png) : null;
}

function clip(text: string, max: number): string {
  return text.replace(/[ -]/g, " ").trim().slice(0, max);
}
