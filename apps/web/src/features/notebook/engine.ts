import type { Stroke } from "@mew/shared";
import { type Command, History, PageDocument, type Vec } from "@mew/ink";

import type { NotebookRepository } from "./repository";

type Listener = () => void;

/**
 * One page's editing session: the in-memory document, undo/redo, and write-through persistence.
 * Framework-free; the canvas reads `doc` directly and React only subscribes for toolbar state.
 */
export class PageEngine {
  readonly doc: PageDocument;
  private readonly history = new History();
  private readonly listeners = new Set<Listener>();
  private erasing: Stroke[] | null = null;
  private pendingWrites: Promise<void> = Promise.resolve();

  private constructor(
    private readonly repo: NotebookRepository,
    readonly pageId: string,
    strokes: Stroke[],
    private readonly onError: (error: unknown) => void,
  ) {
    this.doc = new PageDocument(strokes);
  }

  static async open(
    repo: NotebookRepository,
    pageId: string,
    onError: (error: unknown) => void,
  ): Promise<PageEngine> {
    return new PageEngine(repo, pageId, await repo.loadStrokes(pageId), onError);
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

  addStroke(stroke: Stroke): void {
    this.perform({ kind: "add", strokes: [stroke] });
  }

  /** Erases what the eraser touches between two page points. Returns true if anything changed. */
  eraseAlong(from: Vec, to: Vec, radius: number): boolean {
    const hits = this.doc.hitByEraser(from, to, radius);
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
    const command: Command = { kind: "erase", strokes: erased };
    this.history.record(command);
    this.persist(command);
    this.emit();
  }

  undo(): void {
    const command = this.history.undo();
    if (command) this.applyAndPersist(command);
  }

  redo(): void {
    const command = this.history.redo();
    if (command) this.applyAndPersist(command);
  }

  /** Resolves once every queued write has reached IndexedDB. */
  flush(): Promise<void> {
    return this.pendingWrites;
  }

  private perform(command: Command): void {
    this.history.record(command);
    this.applyAndPersist(command);
  }

  private applyAndPersist(command: Command): void {
    this.doc.apply(command);
    this.persist(command);
    this.emit();
  }

  /** Writes are chained so they reach storage in the order the edits happened. */
  private persist(command: Command): void {
    this.pendingWrites = this.pendingWrites
      .then(() =>
        command.kind === "add"
          ? this.repo.putStrokes(command.strokes)
          : this.repo.deleteStrokes(command.strokes.map((s) => s.id)),
      )
      .catch(this.onError);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
