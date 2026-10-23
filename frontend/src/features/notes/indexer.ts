import type { Line, PageDocument } from "@mew/ink";
import {
  type ImageBlock,
  type NotePageSync,
  RECOGNIZE_BATCH_MAX,
  type Recognition,
} from "@mew/shared";

import { strokesOf, studentLines } from "../notebook/export-line";
import type { LocalNoteLine, LocalNoteLines } from "./local-lines";
import { cleanRecognition, type PageLinesPlan, planPageLines } from "./page-lines";
import { afterSync, needsSync, type PageRef, planSync } from "./sync-plan";

/** A page to index: its id, its strokes as a document, and its clips. */
export type IndexedPage = { id: string; doc: PageDocument; images: readonly ImageBlock[] };

export type SyncOutcome = "ok" | "off" | "failed";

export type NoteIndexerDeps = {
  lines: LocalNoteLines;
  recognition: {
    recognize(doc: PageDocument, line: Line): Promise<Recognition | null>;
    recognizeMany(doc: PageDocument, lines: readonly Line[]): Promise<(Recognition | null)[]>;
    cached(doc: PageDocument, line: Line): Recognition | undefined;
    remember(doc: PageDocument, line: Line, recognition: Recognition): void;
    /** The model is reachable (not paused after a 429, and configured). */
    readonly canBatch: boolean;
  };
  /** The notebook and page number the server mirrors; null if the page is gone. */
  pageRef(pageId: string): Promise<PageRef | null>;
  sync(pageId: string, body: NotePageSync): Promise<SyncOutcome>;
  /** The student allows the server copy (settings loaded and notes_index on). */
  syncEnabled(): boolean;
  newId(): string;
};

export type IndexOptions = {
  /** How many unrecognised lines to recognise now (0: only save and sync what's known). */
  recognize: number;
  /**
   * Read the most recently written line on its own first (the tutor may be waiting for it; the
   * request is shared with the tutor's), the rest in one batch. Otherwise, all in one batch.
   */
  currentFirst: boolean;
};

/**
 * A line that couldn't be read twice in this session, while the model was reachable, isn't
 * asked about again (a busy or unreachable model isn't the line's fault).
 */
const MAX_SKIPS = 2;

/**
 * Keeps a page's line records up to date and the server's copy in step (Notes Check N1):
 *
 * 1. work out the page's lines (lasting ids, content hashes, clip text) and save them;
 * 2. recognise the lines that need it, within the budget;
 * 3. save the results, unless a line changed again meanwhile;
 * 4. sync what changed, when the student allows it.
 *
 * Runs for one page id at a time: a request while one runs waits for it.
 */
export class NoteIndexer {
  private readonly running = new Map<string, Promise<void>>();
  private readonly skips = new Map<string, number>();

  constructor(private readonly deps: NoteIndexerDeps) {}

  index(page: IndexedPage, options: IndexOptions): Promise<void> {
    const previous = this.running.get(page.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.run(page, options))
      .finally(() => {
        if (this.running.get(page.id) === next) this.running.delete(page.id);
      });
    this.running.set(page.id, next);
    return next;
  }

  /** Whether the page still has lines to recognise or to sync (the backfill's question). */
  async hasWork(page: IndexedPage): Promise<boolean> {
    const plan = this.plan(page, await this.deps.lines.forPage(page.id));
    return this.recognisable(plan).length > 0 || (this.deps.syncEnabled() && needsSync(plan.lines));
  }

  private async run(page: IndexedPage, options: IndexOptions): Promise<void> {
    const { lines } = this.deps;

    // 1. The page's lines as they are now.
    const plan = await lines.transaction(async () => {
      const current = this.plan(page, await lines.forPage(page.id));
      await lines.delete(current.drop);
      await lines.put(current.lines);
      return current;
    });
    this.primeCache(page, plan);

    // 2. and 3.
    const most = options.currentFirst ? 1 + RECOGNIZE_BATCH_MAX : RECOGNIZE_BATCH_MAX;
    const chosen = this.recognisable(plan).slice(0, Math.min(options.recognize, most));
    if (chosen.length > 0) {
      await this.saveRecognitions(page.id, await this.read(page, chosen, options.currentFirst));
    }

    // 4.
    if (this.deps.syncEnabled()) await this.syncPage(page.id);
  }

  private plan(page: IndexedPage, stored: readonly LocalNoteLine[]): PageLinesPlan {
    return planPageLines({
      pageId: page.id,
      ink: studentLines(page.doc).map((line) => ({ line, strokes: strokesOf(page.doc, [line]) })),
      images: page.images,
      stored,
      known: (line) => this.deps.recognition.cached(page.doc, line),
      newId: this.deps.newId,
    });
  }

  private recognisable(plan: PageLinesPlan): PageLinesPlan["toRecognize"] {
    return plan.toRecognize.filter((r) => (this.skips.get(skipKey(r)) ?? 0) < MAX_SKIPS);
  }

  /** Recognitions stored with the page answer the tutor too, without asking the model again. */
  private primeCache(page: IndexedPage, plan: PageLinesPlan): void {
    const records = new Map(plan.lines.map((r) => [r.id, r]));
    for (const { id, line } of plan.ink) {
      const recognition = records.get(id)?.recognition;
      if (recognition && !this.deps.recognition.cached(page.doc, line)) {
        this.deps.recognition.remember(page.doc, line, recognition);
      }
    }
  }

  /** Reads the chosen lines (in one batch, or the first alone and the rest in one batch). */
  private async read(
    page: IndexedPage,
    chosen: PageLinesPlan["toRecognize"],
    currentFirst: boolean,
  ): Promise<ReadLine[]> {
    const { recognition } = this.deps;
    const [first] = chosen;
    const alone = first && (currentFirst || chosen.length === 1) ? first : null;
    const rest = alone ? chosen.slice(1) : chosen;
    const results: ReadLine[] = [];
    if (alone) {
      results.push({ ...alone, recognition: await recognition.recognize(page.doc, alone.line) });
    }
    if (rest.length > 0) {
      const batch = await recognition.recognizeMany(
        page.doc,
        rest.map((r) => r.line),
      );
      rest.forEach((r, i) => results.push({ ...r, recognition: batch[i] ?? null }));
    }
    if (recognition.canBatch) {
      for (const result of results) {
        if (!result.recognition)
          this.skips.set(skipKey(result), (this.skips.get(skipKey(result)) ?? 0) + 1);
      }
    }
    return results;
  }

  private async saveRecognitions(pageId: string, results: readonly ReadLine[]): Promise<void> {
    const { lines } = this.deps;
    await lines.transaction(async () => {
      const current = new Map((await lines.forPage(pageId)).map((l) => [l.id, l]));
      const updated: LocalNoteLine[] = [];
      for (const { id, contentHash, recognition } of results) {
        const record = current.get(id);
        const clean = cleanRecognition(recognition);
        // No result, or the line changed while it was being read (the result is about old ink).
        if (!clean || !record || record.removed || record.contentHash !== contentHash) continue;
        updated.push({ ...record, recognition: clean });
      }
      await lines.put(updated);
    });
  }

  private async syncPage(pageId: string): Promise<void> {
    const ref = await this.deps.pageRef(pageId);
    if (!ref) return;
    const { lines } = this.deps;
    for (const batch of planSync(await lines.forPage(pageId), ref)) {
      // Not accepted: nothing is marked synced, so the same changes go next time.
      if ((await this.deps.sync(pageId, batch.body)) !== "ok") return;
      await lines.transaction(async () => {
        const { save, drop } = afterSync(await lines.forPage(pageId), batch.sent);
        await lines.put(save);
        await lines.delete(drop);
      });
    }
  }
}

type ReadLine = { id: string; contentHash: string; recognition: Recognition | null };

function skipKey({ id, contentHash }: { id: string; contentHash: string }): string {
  return `${id}:${contentHash}`;
}
