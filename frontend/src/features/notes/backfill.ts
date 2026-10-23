import type { IndexedPage, NoteIndexer } from "./indexer";

export type BackfillDeps = {
  indexer: Pick<NoteIndexer, "index" | "hasWork">;
  /** Pages to go through, in order: the open notebook's first, then course notebooks'. */
  candidatePages(): Promise<string[]>;
  /** Pages with lines the server doesn't have in their latest form. */
  pagesToSync(): Promise<string[]>;
  /** The page as it is now (the open one from the editor, others from storage). */
  loadPage(pageId: string): Promise<IndexedPage | null>;
  /** Nothing more important is going on: online, visible, not writing, the tutor and model idle. */
  ready(): boolean;
  syncEnabled(): boolean;
  /** The server copy was deleted (the setting went off): forget what was synced. */
  forgetSynced(): Promise<void>;
};

/** Pages looked at per tick to find one with work (each is segmented on the device). */
const PAGES_PER_TICK = 10;
/** One batch per tick: the backfill's whole recognition budget. */
const LINES_PER_TICK = 8;

/**
 * Recognises lines that were never recognised (notebooks written before Notes Check, or lines
 * left behind while the model was busy) and syncs pages that are behind, slowly: called on a
 * timer, it does at most one batch of recognition per tick, and nothing while the student is
 * busy (docs/SCREEN_COACH_NOTES_CHECK.md, decision 3).
 */
export class NoteBackfill {
  /** Pages with nothing left to do in this session (edits are indexed as they happen). */
  private readonly done = new Set<string>();
  private wasEnabled: boolean | null = null;
  private ticking = false;

  constructor(private readonly deps: BackfillDeps) {}

  async tick(): Promise<void> {
    if (this.ticking || !this.deps.ready()) return;
    this.ticking = true;
    try {
      await this.step();
    } finally {
      this.ticking = false;
    }
  }

  private async step(): Promise<void> {
    const enabled = this.deps.syncEnabled();
    if (enabled !== this.wasEnabled) {
      // Off: the server deleted its copy. On again: every page has to be sent again.
      if (!enabled) await this.deps.forgetSynced();
      this.done.clear();
      this.wasEnabled = enabled;
    }

    const pages = [
      ...(enabled ? await this.deps.pagesToSync() : []),
      ...(await this.deps.candidatePages()),
    ];
    let looked = 0;
    for (const pageId of new Set(pages)) {
      if (this.done.has(pageId)) continue;
      if (++looked > PAGES_PER_TICK) return;
      const page = await this.deps.loadPage(pageId);
      if (page && (await this.deps.indexer.hasWork(page))) {
        await this.deps.indexer.index(page, { recognize: LINES_PER_TICK, currentFirst: false });
        return;
      }
      this.done.add(pageId);
    }
  }

  /** The student changed a page: it may have work again. */
  touched(pageId: string): void {
    this.done.delete(pageId);
  }
}
