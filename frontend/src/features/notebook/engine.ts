import type { ImageBlock, Stroke } from "@mew/shared";
import {
  addCommand,
  type Command,
  eraseCommand,
  History,
  PageDocument,
  translateStroke,
  type Vec,
} from "@mew/ink";

import type { NotebookRepository } from "./repository";

/**
 * What kind of edit just happened (lets listeners react to e.g. writing vs erasing). "tutor" is
 * the tutor's ink landing on the page: not the student writing.
 */
export type PageChange = "draw" | "erase" | "delete" | "move" | "undo" | "redo" | "sync" | "tutor";

type Listener = (change: PageChange) => void;

/** Posted to other tabs after a page's strokes change in storage. */
type SyncMessage = { type: "strokes-changed"; pageId: string };

function isSyncMessage(data: unknown): data is SyncMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as SyncMessage).type === "strokes-changed" &&
    typeof (data as SyncMessage).pageId === "string"
  );
}

/**
 * One page's editing session: the in-memory document, undo/redo, write-through persistence, and
 * live sync with other tabs showing the same page. Framework-free; the canvas reads `doc`
 * directly and React only subscribes for toolbar state.
 */
export class PageEngine {
  readonly doc: PageDocument;
  private readonly history = new History();
  private readonly listeners = new Set<Listener>();
  private erasing: Stroke[] | null = null;
  private pendingWrites: Promise<void> = Promise.resolve();
  private readonly channel: BroadcastChannel | null;
  private disposed = false;

  private constructor(
    private readonly repo: NotebookRepository,
    readonly pageId: string,
    strokes: Stroke[],
    /** Images on the page (clips saved from the screen, PDF pages), drawn under the ink. */
    private pictures: readonly ImageBlock[],
    private readonly onError: (error: unknown) => void,
  ) {
    this.doc = new PageDocument(strokes);
    this.channel =
      typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(repo.syncChannelName);
    this.channel?.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (isSyncMessage(event.data) && event.data.pageId === this.pageId) {
        void this.reloadFromStorage().catch(this.onError);
      }
    });
  }

  static async open(
    repo: NotebookRepository,
    pageId: string,
    onError: (error: unknown) => void,
  ): Promise<PageEngine> {
    const [strokes, images] = await Promise.all([
      repo.loadStrokes(pageId),
      repo.loadImages(pageId),
    ]);
    return new PageEngine(repo, pageId, strokes, images, onError);
  }

  /** Images on the page (clips saved from the screen, PDF pages), drawn under the ink. */
  get images(): readonly ImageBlock[] {
    return this.pictures;
  }

  /** PDF pages kept on this device (K4). */
  get pdfCache() {
    return this.repo.pdfCache;
  }

  /**
   * A PDF page's text layer arrived (K4): kept with its picture, so the tutor (and Circle & Ask)
   * reads the page's own text, like a clip's.
   */
  noteImageText(imageId: string, text: string): void {
    if (!text) return;
    this.pictures = this.pictures.map((image) =>
      image.id === imageId && !image.ocrText ? { ...image, ocrText: text.slice(0, 8_000) } : image,
    );
    void this.repo.setImageText(imageId, text).catch(this.onError);
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.channel?.close();
    this.listeners.clear();
  }

  addStroke(stroke: Stroke): void {
    this.perform(addCommand([stroke]), "draw");
  }

  /** Adds the tutor's ink for one turn as a single undo step. */
  addTutorStrokes(strokes: readonly Stroke[]): void {
    if (strokes.length === 0) return;
    this.perform(addCommand([...strokes]), "tutor");
  }

  deleteStrokes(ids: readonly string[]): void {
    this.perform(eraseCommand(this.existing(ids)), "delete");
  }

  /** Moves strokes by (dx, dy) page units as a single undo step. */
  moveStrokes(ids: readonly string[], dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    const before = this.existing(ids);
    this.perform({ removed: before, added: before.map((s) => translateStroke(s, dx, dy)) }, "move");
  }

  /** Erases what the eraser touches between two page points. Returns true if anything changed. */
  eraseAlong(
    from: Vec,
    to: Vec,
    radius: number,
    erasable: (stroke: Stroke) => boolean = () => true,
  ): boolean {
    const hits = this.doc.hitByEraser(from, to, radius).filter(erasable);
    if (hits.length === 0) return false;
    this.doc.remove(hits.map((s) => s.id));
    (this.erasing ??= []).push(...hits);
    return true;
  }

  /** Ends an eraser gesture: everything it removed becomes a single undo step. */
  endErase(): void {
    const erased = this.erasing;
    this.erasing = null;
    if (!erased?.length) return;
    const command = eraseCommand(erased);
    this.history.record(command);
    this.persist(command);
    this.emit("erase");
  }

  undo(): void {
    const command = this.history.undo();
    if (command) this.applyAndPersist(command, "undo");
  }

  redo(): void {
    const command = this.history.redo();
    if (command) this.applyAndPersist(command, "redo");
  }

  /** Resolves once every queued write has reached IndexedDB. */
  flush(): Promise<void> {
    return this.pendingWrites;
  }

  /**
   * Brings the document in line with storage after another tab changed this page. Not an undo
   * step: it records someone else's edit, not ours.
   */
  async reloadFromStorage(): Promise<void> {
    const fresh = new Map((await this.repo.loadStrokes(this.pageId)).map((s) => [s.id, s]));
    const removed = this.doc.all().filter((s) => !sameStroke(s, fresh.get(s.id)));
    const added = [...fresh.values()].filter((s) => !sameStroke(s, this.doc.get(s.id)));
    if (removed.length === 0 && added.length === 0) return;
    this.doc.apply({ removed, added });
    this.emit("sync");
  }

  private existing(ids: readonly string[]): Stroke[] {
    return ids.map((id) => this.doc.get(id)).filter((s) => s !== undefined);
  }

  private perform(command: Command, change: PageChange): void {
    this.history.record(command);
    this.applyAndPersist(command, change);
  }

  private applyAndPersist(command: Command, change: PageChange): void {
    this.doc.apply(command);
    this.persist(command);
    this.emit(change);
  }

  /** Writes are chained so they reach storage in the order the edits happened. */
  private persist(command: Command): void {
    const kept = new Set(command.added.map((s) => s.id));
    const deleted = command.removed.map((s) => s.id).filter((id) => !kept.has(id));
    this.pendingWrites = this.pendingWrites
      .then(async () => {
        await this.repo.deleteStrokes(deleted);
        await this.repo.putStrokes(command.added);
        // A page closed with writes still queued (e.g. tutor ink landing) has no channel left.
        if (!this.disposed)
          this.channel?.postMessage({
            type: "strokes-changed",
            pageId: this.pageId,
          } satisfies SyncMessage);
      })
      .catch(this.onError);
  }

  private emit(change: PageChange): void {
    for (const listener of this.listeners) listener(change);
  }
}

/** Strokes are immutable except for moves, which change their box. */
function sameStroke(a: Stroke | undefined, b: Stroke | undefined): boolean {
  if (!a || !b) return false;
  return (
    a === b || (a.points.length === b.points.length && a.bbox.every((v, i) => v === b.bbox[i]))
  );
}
