import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { z } from "zod";

import {
  ChildLabel,
  Notebook,
  NotebookColor,
  NotebookIcon,
  Position,
  type NotebookColor as Color,
  type NotebookIcon as Icon,
} from "./notebook";
import { Subject } from "./tutor";

/**
 * The notebook tree's rules (K1, docs/NOTEBOOKS_K.md §2): three levels at most, sibling names
 * unique ignoring case, order by fractional index, trash for 30 days. The device applies them
 * as the student edits; the database enforces the same ones again (migration
 * 20261030000000_notebook_tree.sql), and its answers come back through the sync schemas below.
 */

export const TREE_LIMITS = {
  /** Depth of the deepest node: notebook (0) › chapter (1) › section (2). */
  maxDepth: 2,
  /** A new or renamed node's title (older notebooks may be longer, up to 200). */
  titleChars: 80,
  /** Chapters made at once from the creation popover. */
  chaptersAtCreation: 50,
  trashDays: 30,
  nodesPerSync: 200,
  removedPerSync: 500,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The parts of a node the tree's rules look at. */
export type TreeNode = Pick<Notebook, "id" | "parentId" | "title" | "position" | "deletedAt">;

export type MoveCheck = { ok: true } | { ok: false; reason: "depth" | "cycle" | "missing" };

/** A read-only view of a set of nodes as a tree. */
export class NotebookTree<T extends TreeNode> {
  private readonly byId = new Map<string, T>();
  private readonly byParent = new Map<string | null, T[]>();

  constructor(nodes: readonly T[]) {
    for (const node of nodes) this.byId.set(node.id, node);
    for (const node of nodes) {
      // A node whose parent is unknown here (not synced yet, purged) shows at the top level.
      const parent = node.parentId !== null && this.byId.has(node.parentId) ? node.parentId : null;
      const siblings = this.byParent.get(parent) ?? [];
      siblings.push(node);
      this.byParent.set(parent, siblings);
    }
    for (const siblings of this.byParent.values()) siblings.sort(byPosition);
  }

  get(id: string): T | undefined {
    return this.byId.get(id);
  }

  /** The parent as the tree sees it (null at the top level). */
  parentOf(id: string): string | null {
    const parentId = this.byId.get(id)?.parentId ?? null;
    return parentId !== null && this.byId.has(parentId) ? parentId : null;
  }

  /** Children in order, without trashed ones unless asked. */
  children(parentId: string | null, { trashed = false } = {}): T[] {
    const all = this.byParent.get(parentId) ?? [];
    return trashed ? [...all] : all.filter((n) => n.deletedAt === undefined);
  }

  /** The node and its ancestors, top first. */
  path(id: string): T[] {
    const path: T[] = [];
    for (let at = this.byId.get(id); at; at = this.byParentOf(at)) {
      path.unshift(at);
      if (path.length > TREE_LIMITS.maxDepth + 2) break; // a corrupt loop never hangs
    }
    return path;
  }

  depth(id: string): number {
    return this.path(id).length - 1;
  }

  /** How many levels sit under a node (0 for a node without children, trash included). */
  height(id: string): number {
    const below = this.children(id, { trashed: true });
    return below.length === 0 ? 0 : 1 + Math.max(...below.map((child) => this.height(child.id)));
  }

  /** Every node under `id`, trash included, nearest first. */
  descendants(id: string): T[] {
    const found: T[] = [];
    const queue = this.children(id, { trashed: true });
    for (let next = queue.shift(); next; next = queue.shift()) {
      found.push(next);
      queue.push(...this.children(next.id, { trashed: true }));
    }
    return found;
  }

  /** Neither the node nor any of its ancestors is in the trash. */
  isLive(id: string): boolean {
    const path = this.path(id);
    return path.length > 0 && path.every((n) => n.deletedAt === undefined);
  }

  /** Whether `id` can go under `parentId` (null: the top level) without breaking the rules. */
  canMove(id: string, parentId: string | null): MoveCheck {
    if (!this.byId.has(id) || (parentId !== null && !this.byId.has(parentId))) {
      return { ok: false, reason: "missing" };
    }
    if (parentId !== null && (parentId === id || this.path(parentId).some((n) => n.id === id))) {
      return { ok: false, reason: "cycle" };
    }
    const depth = parentId === null ? 0 : this.depth(parentId) + 1;
    return depth + this.height(id) > TREE_LIMITS.maxDepth
      ? { ok: false, reason: "depth" }
      : { ok: true };
  }

  /** A live sibling under `parentId` already has this name (ignoring case). */
  nameTaken(parentId: string | null, title: string, exceptId?: string): boolean {
    const wanted = title.toLocaleLowerCase();
    return this.children(parentId).some(
      (n) => n.id !== exceptId && n.title.toLocaleLowerCase() === wanted,
    );
  }

  /** `title`, or the first free "title 2", "title 3"… among the siblings. */
  freeName(parentId: string | null, title: string, exceptId?: string): string {
    if (!this.nameTaken(parentId, title, exceptId)) return title;
    const stem = title.slice(0, TREE_LIMITS.titleChars - 4);
    for (let n = 2; ; n++) {
      const candidate = `${stem} ${n}`;
      if (!this.nameTaken(parentId, candidate, exceptId)) return candidate;
    }
  }

  /**
   * A position that puts a node at `index` among `parentId`'s live children (the end when
   * `index` is past them), leaving `exceptId` out (the node being moved).
   */
  positionAt(parentId: string | null, index: number, exceptId?: string): string {
    const siblings = this.children(parentId).filter((n) => n.id !== exceptId);
    const at = Math.max(0, Math.min(index, siblings.length));
    return between(siblings[at - 1]?.position ?? null, siblings[at]?.position ?? null);
  }

  /**
   * `count` positions after every child of `parentId`, trashed ones included: a node restored
   * from the trash then goes back exactly where it was, never sharing a key with a newer one.
   */
  positionsAtEnd(parentId: string | null, count: number): string[] {
    const last = this.children(parentId, { trashed: true }).at(-1)?.position ?? null;
    return keysAfter(last, count);
  }

  /** Trashed nodes the student sees in the trash (not those inside a trashed node). */
  trash(): T[] {
    return [...this.byId.values()]
      .filter((n) => n.deletedAt !== undefined)
      .filter((n) => {
        const parent = this.parentOf(n.id);
        return parent === null || this.isLive(parent);
      })
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  }

  /** Nodes to purge: trash older than 30 days, with everything under it. */
  expired(now: number): string[] {
    return this.trash()
      .filter((n) => now - (n.deletedAt ?? now) >= TREE_LIMITS.trashDays * DAY_MS)
      .flatMap((n) => [n.id, ...this.descendants(n.id).map((d) => d.id)]);
  }

  private byParentOf(node: T): T | undefined {
    return node.parentId === null ? undefined : this.byId.get(node.parentId);
  }
}

function byPosition(a: TreeNode, b: TreeNode): number {
  // Plain code-unit order: fractional-indexing keys are made for it (never localeCompare).
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * A key between two neighbours. Keys come from other devices and the server too, so a bad one
 * never throws: two siblings sharing a key (moved on two devices) open a gap after the first,
 * and a malformed key is treated as missing (the node lands at that end).
 */
function between(before: string | null, after: string | null): string {
  const low = validKey(before);
  const high = validKey(after);
  if (low !== null && high !== null && low >= high) return generateKeyBetween(low, null);
  return generateKeyBetween(low, high);
}

/** `count` keys after `last` (all at the start when `last` is malformed). */
function keysAfter(last: string | null, count: number): string[] {
  return generateNKeysBetween(validKey(last), null, count);
}

function validKey(key: string | null): string | null {
  if (key === null) return null;
  try {
    generateKeyBetween(key, null); // validates `key`
    return key;
  } catch {
    return null;
  }
}

/** A title as typed, trimmed and with runs of spaces closed; null when empty or too long. */
export function cleanTitle(raw: string): string | null {
  const title = raw.replace(/\s+/g, " ").trim();
  return title.length >= 1 && title.length <= TREE_LIMITS.titleChars ? title : null;
}

/** "Chapter" for "Chapters": what one child is called. */
export function singular(label: ChildLabel): string {
  return label.slice(0, -1);
}

/** Default titles for `count` new children: "Chapter 1" … "Chapter n" (or Unit, Week…). */
export function childTitles(count: number, label: ChildLabel, startAt = 1): string[] {
  const n = Math.max(0, Math.min(Math.floor(count), TREE_LIMITS.chaptersAtCreation));
  return Array.from({ length: n }, (_, i) => `${singular(label)} ${startAt + i}`);
}

/** Keyword stems → an icon and colour, so "Physics" starts as an atom in teal. */
const STYLES: readonly (readonly [RegExp, Icon, Color])[] = [
  [/\b(phys|mechanic|optic|thermo|quantum|astro)/, "atom", "teal"],
  [/\b(chem|organic|biochem)/, "flask", "amber"],
  [/\b(math|calc|algebra|geometr|statist|trig|linear|discrete)/, "sigma", "blue"],
  [/\b(bio|anatom|physiolog|genetic|microbio|medic)/, "dna", "green"],
  [/\b(ecolog|environment|botan|plant|earth|geolog)/, "leaf", "green"],
  [/\b(geograph|world|global|travel)/, "globe", "teal"],
  [/\b(comput|program|code|coding|software|algorithm|data|cs\b|eecs|web)/, "code", "slate"],
  [/\b(histor|law|legal|politic|govern|civic|econom)/, "landmark", "amber"],
  [
    /\b(english|french|spanish|german|chinese|japanese|language|literat|writing|latin)/,
    "languages",
    "rose",
  ],
  [/\b(music|piano|guitar|choir|band)/, "music", "rose"],
  [/\b(art|design|drawing|paint|photo)/, "palette", "rose"],
  [/\b(psych|neuro|philosoph|cognit|sociolog)/, "brain", "slate"],
  [/\b(account|financ|business|market)/, "calculator", "amber"],
];

/** What a notebook's icon says it's about (K8): "Physics" (atom) → physics. */
const SUBJECT_OF_ICON: Partial<Record<Icon, Subject>> = {
  atom: "physics",
  flask: "chemistry",
  sigma: "math",
  calculator: "math",
  dna: "biology",
  leaf: "biology",
  code: "programming",
  landmark: "history",
  languages: "language",
};

/** The subject suggested for a notebook's name (K8), or null when the name doesn't say. */
export function suggestSubject(title: string): Subject | null {
  const name = title.toLowerCase();
  const match = STYLES.find(([pattern]) => pattern.test(name));
  return (match && SUBJECT_OF_ICON[match[1]]) ?? null;
}

/** The icon and colour suggested for a new notebook's name (the student can change both). */
export function suggestStyle(title: string): { icon: Icon; color: Color } {
  const name = title.toLowerCase();
  const match = STYLES.find(([pattern]) => pattern.test(name));
  return match ? { icon: match[1], color: match[2] } : { icon: "book", color: "slate" };
}

// ─── Sync with the server ──────────────────────────────────────────────────────────────────

const Millis = z.number().int().nonnegative();

/** One node as the device and the server exchange it. */
export const NotebookNodeSync = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  title: z.string().trim().min(1).max(200),
  position: Position,
  childLabel: ChildLabel,
  icon: NotebookIcon.nullable(),
  color: NotebookColor.nullable(),
  courseId: z.uuid().nullable(),
  /** K8 (older devices and servers send none). */
  subject: Subject.nullable().default(null),
  deletedAt: Millis.nullable(),
  editedAt: Millis,
});
export type NotebookNodeSync = z.infer<typeof NotebookNodeSync>;

/** The device's changes: nodes added or changed (parents first), and nodes purged. */
export const NotebookTreeSync = z.object({
  nodes: z.array(NotebookNodeSync).max(TREE_LIMITS.nodesPerSync),
  removed: z.array(z.uuid()).max(TREE_LIMITS.removedPerSync),
});
export type NotebookTreeSync = z.infer<typeof NotebookTreeSync>;

/**
 * What the server did with each node: kept it ("saved"), kept it under a numbered name
 * ("renamed"), kept its own later edit ("stale"), or refused it ("rejected"). `node` is the
 * server's copy afterwards (null when it has none).
 */
export const NodeSyncStatus = z.enum(["saved", "renamed", "stale", "rejected"]);
export type NodeSyncStatus = z.infer<typeof NodeSyncStatus>;

export const NotebookTreeSyncResult = z.object({
  results: z
    .array(z.object({ id: z.uuid(), status: NodeSyncStatus, node: NotebookNodeSync.nullable() }))
    .max(TREE_LIMITS.nodesPerSync),
});
export type NotebookTreeSyncResult = z.infer<typeof NotebookTreeSyncResult>;

/** Every node the server has for the student (another device's edits come this way). */
export const NotebookTreeView = z.object({
  nodes: z.array(NotebookNodeSync).max(5_000),
});
export type NotebookTreeView = z.infer<typeof NotebookTreeView>;

export function toNodeSync(node: Notebook): NotebookNodeSync {
  return {
    id: node.id,
    parentId: node.parentId,
    title: node.title,
    position: node.position,
    childLabel: node.childLabel,
    icon: node.icon ?? null,
    color: node.color ?? null,
    courseId: node.courseId ?? null,
    subject: node.subject ?? null,
    deletedAt: node.deletedAt ?? null,
    editedAt: node.editedAt,
  };
}

/**
 * The server's copy as a local node, keeping the local recency. A node new to this device takes
 * its last edit as its recency (or `now` when that's unknown).
 */
export function fromNodeSync(node: NotebookNodeSync, local: Notebook | undefined, now: number) {
  return Notebook.parse({
    id: node.id,
    title: node.title,
    parentId: node.parentId,
    position: node.position,
    childLabel: node.childLabel,
    ...(node.icon && { icon: node.icon }),
    ...(node.color && { color: node.color }),
    ...(node.courseId && { courseId: node.courseId }),
    ...(node.subject && { subject: node.subject }),
    ...(node.deletedAt !== null && { deletedAt: node.deletedAt }),
    editedAt: node.editedAt,
    createdAt: local?.createdAt ?? (node.editedAt || now),
    updatedAt: local?.updatedAt ?? (node.editedAt || now),
  });
}
