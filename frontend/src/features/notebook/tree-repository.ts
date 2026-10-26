import {
  type ChildLabel,
  childTitles,
  cleanTitle,
  type MoveCheck,
  Notebook,
  type NotebookColor,
  type NotebookIcon,
  type NotebookNodeSync,
  NotebookTree,
  type NotebookTreeSyncResult,
  singular,
  toNodeSync,
  TREE_LIMITS,
} from "@mew/shared";

import { liveQuery } from "dexie";

import type { NotebookDb } from "./db";
import { newPage } from "./page-factory";
import { planPull, planResults, type TreeNotice } from "./tree-sync-plan";

/** A notebook as the creation popover makes it (K1, docs/NOTEBOOKS_K.md §2.2). */
export type NewNotebook = {
  title: string;
  icon?: NotebookIcon;
  color?: NotebookColor;
  courseId?: string;
  childLabel?: ChildLabel;
  /** Its chapters' titles, in order (each gets a first page). */
  chapters?: readonly string[];
};

export type RenameResult =
  | { ok: true; previous: string }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "taken"; suggestion: string };

export type MoveResult = { ok: true; renamedTo?: string } | Extract<MoveCheck, { ok: false }>;

/** The changes waiting for the server, at most one sync's worth. */
export type PendingTree = { nodes: NotebookNodeSync[]; removed: string[] };

/** A server refusal without a copy of its own is tried this many times, then dropped. */
const MAX_FAILURES = 3;

/**
 * The notebook tree on this device (K1): notebooks, chapters and sections. Every edit is one
 * transaction that also queues the node for the server (the outbox), so nothing the student
 * does is lost or half-done, and the server's answers are applied the same way.
 *
 * The rules (three levels, unique sibling names, order) come from `NotebookTree`; the database
 * enforces them again (decision 0.1 #6).
 */
export class TreeRepository {
  constructor(
    private readonly db: NotebookDb,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  // Reads used inside transactions are Dexie promise chains (`.then`), not `async` functions:
  // across nested native awaits Dexie can lose track of the transaction it's in, and in a real
  // browser that commits it early ("PrematureCommitError"; fake IndexedDB doesn't show it).

  /** Every node, trash included. Rows that don't parse are skipped, never trusted. */
  nodes(): Promise<Notebook[]> {
    return this.db.notebooks.toArray().then(validNodes);
  }

  tree(): Promise<NotebookTree<Notebook>> {
    return this.nodes().then((nodes) => new NotebookTree(nodes));
  }

  /**
   * Calls `onChange` with every node now and after every change (this tab's, another tab's, or
   * a sync's). Returns a function that stops.
   */
  observe(onChange: (nodes: Notebook[]) => void, onError: (error: unknown) => void): () => void {
    const subscription = liveQuery(() => this.nodes()).subscribe({
      next: onChange,
      error: onError,
    });
    return () => subscription.unsubscribe();
  }

  /** Calls `onQueued` whenever changes are waiting for the server. Returns a function that stops. */
  observeQueue(onQueued: () => void): () => void {
    const subscription = liveQuery(() => this.db.treeOutbox.count()).subscribe({
      next: (count) => {
        if (count > 0) onQueued();
      },
    });
    return () => subscription.unsubscribe();
  }

  // ─── Making ───────────────────────────────────────────────────────────────────────────────

  /**
   * A new notebook at the end of the top level, with its chapters. A name that's taken gets a
   * number (the popover warns before); the chapters' names are made unique among themselves.
   * A notebook without chapters gets a first page; each chapter gets one.
   */
  async createNotebook(input: NewNotebook): Promise<Notebook> {
    return this.write(async () => {
      const tree = await this.tree();
      const now = this.clock();
      const notebook = Notebook.parse({
        id: crypto.randomUUID(),
        title: tree.freeName(null, cleanTitle(input.title) ?? "Untitled notebook"),
        parentId: null,
        position: tree.positionsAtEnd(null, 1)[0],
        childLabel: input.childLabel ?? "Chapters",
        ...(input.icon && { icon: input.icon }),
        ...(input.color && { color: input.color }),
        ...(input.courseId && { courseId: input.courseId }),
        editedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const titles = uniqueTitles(input.chapters ?? []);
      const positions = new NotebookTree<Notebook>([]).positionsAtEnd(null, titles.length);
      const chapters = titles.map((title, i) =>
        Notebook.parse({
          id: crypto.randomUUID(),
          title,
          parentId: notebook.id,
          position: positions[i],
          editedAt: now,
          createdAt: now,
          updatedAt: now,
        }),
      );
      await this.db.notebooks.bulkAdd([notebook, ...chapters]);
      const holders = chapters.length > 0 ? chapters : [notebook];
      await this.db.pages.bulkAdd(holders.map((node) => newPage(node.id, 0)));
      await this.queue([notebook.id, ...chapters.map((c) => c.id)]);
      return notebook;
    });
  }

  /**
   * A new chapter (or section) at the end of `parentId`, named "Chapter n" after its label
   * unless a title is given, with a first page (not when its pages come from a PDF, K4). Null
   * when the parent is a section already.
   */
  async addChild(
    parentId: string,
    title?: string,
    { withPage = true }: { withPage?: boolean } = {},
  ): Promise<Notebook | null> {
    return this.write(async () => {
      const tree = await this.tree();
      const parent = tree.get(parentId);
      if (!parent || tree.depth(parentId) >= TREE_LIMITS.maxDepth) return null;
      const root = tree.path(parentId)[0] ?? parent;
      const count = tree.children(parentId).length;
      const wanted =
        (title ? cleanTitle(title) : null) ?? childTitles(1, root.childLabel, count + 1)[0];
      const now = this.clock();
      const child = Notebook.parse({
        id: crypto.randomUUID(),
        title: tree.freeName(parentId, wanted ?? singular(root.childLabel)),
        parentId,
        position: tree.positionsAtEnd(parentId, 1)[0],
        editedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await this.db.notebooks.add(child);
      if (withPage) await this.db.pages.add(newPage(child.id, 0));
      await this.queue([child.id]);
      return child;
    });
  }

  /** Links a notebook to a course (K4: "Use as course material" made one for it). */
  async setCourse(id: string, courseId: string): Promise<void> {
    await this.write(async () => {
      const node = (await this.tree()).get(id);
      if (node && node.courseId !== courseId) await this.save(node, { courseId });
    });
  }

  // ─── Changing ─────────────────────────────────────────────────────────────────────────────

  async rename(id: string, raw: string): Promise<RenameResult> {
    return this.write(async () => {
      const tree = await this.tree();
      const node = tree.get(id);
      const title = cleanTitle(raw);
      if (!node || !title) return { ok: false, reason: "invalid" };
      if (tree.nameTaken(node.parentId, title, id)) {
        return { ok: false, reason: "taken", suggestion: tree.freeName(node.parentId, title, id) };
      }
      if (title !== node.title) await this.save(node, { title });
      return { ok: true, previous: node.title };
    });
  }

  /**
   * Moves a node (with everything under it) to `index` among `parentId`'s children. A name taken
   * at the new place gets a number, and the result says so.
   */
  async move(id: string, parentId: string | null, index: number): Promise<MoveResult> {
    return this.write(async () => {
      const tree = await this.tree();
      const check = tree.canMove(id, parentId);
      const node = tree.get(id);
      if (!check.ok) return check;
      if (!node) return { ok: false, reason: "missing" };
      const title = tree.freeName(parentId, node.title, id);
      const position = tree.positionAt(parentId, index, id);
      await this.save(node, { parentId, position, title });
      return title === node.title ? { ok: true } : { ok: true, renamedTo: title };
    });
  }

  /** One place up (-1) or down (+1) among its siblings; false at either end. */
  async reorder(id: string, step: -1 | 1): Promise<boolean> {
    return this.write(async () => {
      const tree = await this.tree();
      const node = tree.get(id);
      if (!node) return false;
      const parentId = tree.parentOf(id);
      const siblings = tree.children(parentId);
      const at = siblings.findIndex((n) => n.id === id);
      const to = at + step;
      if (at < 0 || to < 0 || to >= siblings.length) return false;
      await this.save(node, { position: tree.positionAt(parentId, to, id) });
      return true;
    });
  }

  /** To the trash (with everything under it, which stays inside it). */
  async trash(id: string): Promise<void> {
    await this.write(async () => {
      const node = (await this.tree()).get(id);
      if (node && node.deletedAt === undefined) await this.save(node, { deletedAt: this.clock() });
    });
  }

  /** Out of the trash; a name taken meanwhile gets a number, and the result says so. */
  async restore(id: string): Promise<{ renamedTo?: string }> {
    return this.write(async () => {
      const tree = await this.tree();
      const node = tree.get(id);
      if (!node || node.deletedAt === undefined) return {};
      const title = tree.freeName(node.parentId, node.title, id);
      await this.save(node, { deletedAt: undefined, title });
      return title === node.title ? {} : { renamedTo: title };
    });
  }

  /** Deletes nodes for good, with everything under them and on their pages. */
  async purge(ids: readonly string[]): Promise<void> {
    await this.write(async () => {
      const tree = await this.tree();
      const all = [...new Set(ids.flatMap((id) => [id, ...tree.descendants(id).map((n) => n.id)]))];
      const pages = await this.db.pages.where("notebookId").anyOf(all).primaryKeys();
      await this.db.strokes.where("pageId").anyOf(pages).delete();
      await this.db.images.where("pageId").anyOf(pages).delete();
      await this.db.noteLines.where("pageId").anyOf(pages).delete();
      await this.db.pages.bulkDelete(pages);
      await this.db.notebooks.bulkDelete(all);
      await this.db.treeOutbox.bulkPut(all.map((id) => ({ id, kind: "removed", failures: 0 })));
    });
  }

  /** Empties trash older than 30 days. Returns how many nodes went. */
  async purgeExpired(): Promise<number> {
    const expired = (await this.tree()).expired(this.clock());
    if (expired.length > 0) await this.purge(expired);
    return expired.length;
  }

  // ─── Syncing (TreeSync calls these) ───────────────────────────────────────────────────────

  /** What to send: queued nodes parents first, and purged ids (one sync's worth of each). */
  async pending(): Promise<PendingTree> {
    const [entries, tree] = await Promise.all([this.db.treeOutbox.toArray(), this.tree()]);
    const queued = entries.filter((e) => e.kind === "node").map((e) => tree.get(e.id));
    const nodes = queued
      .filter((n): n is Notebook => n !== undefined)
      .sort((a, b) => tree.depth(a.id) - tree.depth(b.id) || compare(a.position, b.position))
      .slice(0, TREE_LIMITS.nodesPerSync)
      .map(toNodeSync);
    const removed = entries
      .filter((e) => e.kind === "removed")
      .map((e) => e.id)
      .slice(0, TREE_LIMITS.removedPerSync);
    return { nodes, removed };
  }

  /** Applies the server's answers; returns what the student should be told. */
  async applyResults(sent: PendingTree, result: NotebookTreeSyncResult): Promise<TreeNotice[]> {
    return this.write(async () => {
      const local = new Map((await this.nodes()).map((n) => [n.id, n]));
      const plan = planResults(sent.nodes, result, local, this.clock());
      await this.db.notebooks.bulkPut(plan.adopt);
      await this.db.treeOutbox.bulkDelete([...plan.done, ...sent.removed]);
      const notices = [...plan.notices];
      for (const id of plan.retry) {
        const entry = await this.db.treeOutbox.get(id);
        if (!entry) continue;
        if (entry.failures + 1 >= MAX_FAILURES) {
          await this.db.treeOutbox.delete(id);
          const title = local.get(id)?.title;
          if (title) notices.push({ kind: "not_saved", title });
        } else {
          await this.db.treeOutbox.put({ ...entry, failures: entry.failures + 1 });
        }
      }
      return notices;
    });
  }

  /** Takes in the server's whole tree (another device's edits). */
  async applyServerTree(server: readonly NotebookNodeSync[]): Promise<void> {
    await this.write(async () => {
      const queued = new Set(await this.db.treeOutbox.toCollection().primaryKeys());
      const plan = planPull(await this.nodes(), server, queued, this.clock());
      await this.db.notebooks.bulkPut(plan.put);
      // A node from another device has no pages here (strokes stay on their device).
      await this.queue(plan.requeue);
    });
  }

  /** The node and its ancestors are on the server (a page's lines may sync, decision 17). */
  async isSynced(id: string): Promise<boolean> {
    const path = (await this.tree()).path(id);
    if (path.length === 0) return false;
    const queued = await this.db.treeOutbox.bulkGet(path.map((n) => n.id));
    return queued.every((entry) => entry === undefined);
  }

  // ─── Inside ───────────────────────────────────────────────────────────────────────────────

  /**
   * One read-write transaction over everything a tree edit touches. Joined when nested, so
   * callers that make notebooks inside their own transaction must open it with this.
   */
  write<T>(fn: () => Promise<T>): Promise<T> {
    const { notebooks, pages, strokes, images, noteLines, treeOutbox } = this.db;
    return this.db.transaction(
      "rw",
      [notebooks, pages, strokes, images, noteLines, treeOutbox],
      fn,
    );
  }

  /** Stores an edit of `node` (stamped as its latest) and queues it. */
  private save(node: Notebook, change: Partial<Notebook>): Promise<unknown> {
    const edited = Notebook.parse({
      ...node,
      ...change,
      editedAt: Math.max(this.clock(), node.editedAt + 1),
    });
    // `deletedAt: undefined` (restore) must remove the field, not keep the old value.
    if ("deletedAt" in change && change.deletedAt === undefined) delete edited.deletedAt;
    return this.db.notebooks.put(edited).then(() => this.queue([node.id]));
  }

  private queue(ids: readonly string[]): Promise<unknown> {
    return this.db.treeOutbox.bulkPut(ids.map((id) => ({ id, kind: "node", failures: 0 })));
  }
}

function validNodes(rows: readonly unknown[]): Notebook[] {
  const valid: Notebook[] = [];
  for (const row of rows) {
    const parsed = Notebook.safeParse(row);
    if (parsed.success) valid.push(parsed.data);
  }
  if (valid.length < rows.length) {
    console.warn(`[notebook] skipped ${rows.length - valid.length} invalid notebook row(s)`);
  }
  return valid;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Chapter titles from the popover: cleaned, empty ones dropped, duplicates numbered. */
function uniqueTitles(raw: readonly string[]): string[] {
  const titles: { id: string; title: string; parentId: null; position: string }[] = [];
  for (const each of raw.slice(0, TREE_LIMITS.chaptersAtCreation)) {
    const title = cleanTitle(each);
    if (!title) continue;
    const unique = new NotebookTree(titles).freeName(null, title);
    titles.push({ id: String(titles.length), title: unique, parentId: null, position: "a0" });
  }
  return titles.map((t) => t.title);
}
