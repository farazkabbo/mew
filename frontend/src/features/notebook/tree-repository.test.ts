import "fake-indexeddb/auto";

import { type Notebook, type NotebookNodeSync, NotebookTree } from "@mew/shared";
import Dexie from "dexie";
import { beforeEach, describe, expect, it } from "vitest";

import { databaseName, NotebookDb } from "./db";
import { NotebookRepository } from "./repository";
import type { TreeRepository } from "./tree-repository";

const DAY = 24 * 60 * 60 * 1000;

let db: NotebookDb;
let repo: NotebookRepository;
let tree: TreeRepository;
let users = 0;

beforeEach(() => {
  db = new NotebookDb(`tree_${++users}`);
  repo = new NotebookRepository(db);
  tree = repo.tree;
});

async function titles(parentId: string | null): Promise<string[]> {
  return (await tree.tree()).children(parentId).map((n) => n.title);
}

async function queued(): Promise<string[]> {
  return (await db.treeOutbox.toArray()).map((e) => `${e.kind}:${e.id}`);
}

describe("making notebooks", () => {
  it("makes a notebook with its chapters, each with a first page, all queued for the server", async () => {
    const physics = await tree.createNotebook({
      title: "  Physics ",
      icon: "atom",
      color: "teal",
      chapters: ["Chapter 1", "Forces", "", "Chapter 3", "chapter 1"],
    });
    expect(physics).toMatchObject({ title: "Physics", parentId: null, icon: "atom" });
    expect(await titles(physics.id)).toEqual(["Chapter 1", "Forces", "Chapter 3", "chapter 1 2"]);

    const chapters = (await tree.tree()).children(physics.id);
    const counts = await repo.countPages([physics.id, ...chapters.map((c) => c.id)]);
    expect(counts.get(physics.id)).toBe(0); // its pages are in its chapters
    expect(chapters.every((c) => counts.get(c.id) === 1)).toBe(true);
    expect(await queued()).toHaveLength(5);
  });

  it("numbers a notebook name that's taken, and gives a notebook without chapters a page", async () => {
    await tree.createNotebook({ title: "Physics" });
    const second = await tree.createNotebook({ title: "physics" });
    expect(second.title).toBe("physics 2");
    expect(await repo.listPages(second.id)).toHaveLength(1);
  });

  it("adds chapters named after the notebook's label, but never a fourth level", async () => {
    const chem = await tree.createNotebook({ title: "Chemistry", childLabel: "Units" });
    const unit = await tree.addChild(chem.id);
    const unit2 = await tree.addChild(chem.id);
    expect([unit?.title, unit2?.title]).toEqual(["Unit 1", "Unit 2"]);
    const section = await tree.addChild(unit?.id ?? "", "Acids");
    expect(section?.title).toBe("Acids");
    expect(await tree.addChild(section?.id ?? "")).toBeNull();
  });
});

describe("changing the tree", () => {
  it("renames, refusing empty names and names taken by a sibling", async () => {
    const physics = await tree.createNotebook({ title: "Physics", chapters: ["A", "B"] });
    const [a] = (await tree.tree()).children(physics.id);
    expect(await tree.rename(a?.id ?? "", "Optics")).toEqual({ ok: true, previous: "A" });
    expect(await tree.rename(a?.id ?? "", "   ")).toEqual({ ok: false, reason: "invalid" });
    expect(await tree.rename(a?.id ?? "", "b")).toEqual({
      ok: false,
      reason: "taken",
      suggestion: "b 2",
    });
    expect(await titles(physics.id)).toEqual(["Optics", "B"]);
  });

  it("moves a chapter with its sections, and refuses a fourth level or a loop", async () => {
    const physics = await tree.createNotebook({ title: "Physics", chapters: ["Kinematics"] });
    const chem = await tree.createNotebook({ title: "Chemistry", chapters: ["Kinematics"] });
    const [kinematics] = (await tree.tree()).children(physics.id);
    const section = await tree.addChild(kinematics?.id ?? "", "Projectiles");

    const moved = await tree.move(kinematics?.id ?? "", chem.id, 0);
    expect(moved).toEqual({ ok: true, renamedTo: "Kinematics 2" }); // Chemistry has one
    expect(await titles(chem.id)).toEqual(["Kinematics 2", "Kinematics"]);
    expect((await tree.tree()).depth(section?.id ?? "")).toBe(2);

    const [chemChapter] = (await tree.tree()).children(chem.id).slice(1);
    expect(await tree.move(kinematics?.id ?? "", chemChapter?.id ?? null, 0)).toEqual({
      ok: false,
      reason: "depth",
    });
    expect(await tree.move(chem.id, section?.id ?? null, 0)).toEqual({
      ok: false,
      reason: "cycle",
    });
  });

  it("reorders siblings one place at a time", async () => {
    const physics = await tree.createNotebook({ title: "Physics", chapters: ["A", "B", "C"] });
    const [, , c] = (await tree.tree()).children(physics.id);
    expect(await tree.reorder(c?.id ?? "", -1)).toBe(true);
    expect(await titles(physics.id)).toEqual(["A", "C", "B"]);
    expect(await tree.reorder(c?.id ?? "", -1)).toBe(true);
    expect(await tree.reorder(c?.id ?? "", -1)).toBe(false);
    expect(await titles(physics.id)).toEqual(["C", "A", "B"]);
  });

  it("trashes and restores, numbering a name taken meanwhile", async () => {
    const physics = await tree.createNotebook({ title: "Physics", chapters: ["A"] });
    await tree.trash(physics.id);
    expect(await titles(null)).toEqual([]);
    expect((await repo.listNotebooks()).map((n) => n.title)).toEqual([]); // chapters too
    await tree.createNotebook({ title: "Physics" });
    expect(await tree.restore(physics.id)).toEqual({ renamedTo: "Physics 2" });
    // Back in its own place (first), under its new name.
    expect(await titles(null)).toEqual(["Physics 2", "Physics"]);
  });

  it("purges trash older than 30 days with its pages, strokes and lines, and tells the server", async () => {
    let now = 100 * DAY;
    const clocked = new NotebookRepository(db);
    Object.assign(clocked.tree, { clock: () => now });
    const physics = await clocked.tree.createNotebook({ title: "Physics", chapters: ["A"] });
    const [chapter] = (await clocked.tree.tree()).children(physics.id);
    const [page] = await repo.listPages(chapter?.id ?? "");
    await db.strokes.add({
      id: crypto.randomUUID(),
      pageId: page?.id ?? "",
      author: "student",
      tool: "pen",
      points: [[0, 0, 0.5, 0]],
      color: "#000000",
      width: 2,
      bbox: [0, 0, 0, 0],
      createdAt: 0,
    });
    await clocked.tree.trash(physics.id);
    await db.treeOutbox.clear();

    now += 29 * DAY;
    expect(await clocked.tree.purgeExpired()).toBe(0);
    now += DAY;
    expect(await clocked.tree.purgeExpired()).toBe(2);
    expect(await db.notebooks.count()).toBe(0);
    expect(await db.pages.count()).toBe(0);
    expect(await db.strokes.count()).toBe(0);
    expect((await queued()).sort()).toEqual(
      [`removed:${physics.id}`, `removed:${chapter?.id}`].sort(),
    );
  });
});

describe("syncing", () => {
  function wire(node: Notebook, changes: Partial<NotebookNodeSync> = {}): NotebookNodeSync {
    return {
      id: node.id,
      parentId: node.parentId,
      title: node.title,
      position: node.position,
      childLabel: node.childLabel,
      icon: node.icon ?? null,
      color: node.color ?? null,
      courseId: node.courseId ?? null,
      deletedAt: node.deletedAt ?? null,
      editedAt: node.editedAt,
      ...changes,
    };
  }

  it("sends parents first and clears what the server saved", async () => {
    const physics = await tree.createNotebook({ title: "Physics", chapters: ["A"] });
    const pending = await tree.pending();
    expect(pending.nodes[0]?.id).toBe(physics.id);
    expect(await tree.isSynced(physics.id)).toBe(false);

    const results = pending.nodes.map((n) => ({ id: n.id, status: "saved" as const, node: n }));
    expect(await tree.applyResults(pending, { results })).toEqual([]);
    expect(await queued()).toEqual([]);
    expect(await tree.isSynced(physics.id)).toBe(true);
  });

  it("takes a numbered name and an undone move from the server, and says so", async () => {
    const physics = await tree.createNotebook({ title: "Physics", chapters: ["A"] });
    const other = await tree.createNotebook({ title: "Other" });
    const [a] = (await tree.tree()).children(physics.id);
    await db.treeOutbox.clear();
    await tree.move(a?.id ?? "", other.id, 0);
    await tree.rename(physics.id, "Mechanics");

    const pending = await tree.pending();
    const sentA = pending.nodes.find((n) => n.id === a?.id);
    const sentPhysics = pending.nodes.find((n) => n.id === physics.id);
    const notices = await tree.applyResults(pending, {
      results: [
        { id: physics.id, status: "renamed", node: wire(physics, { title: "Mechanics 2" }) },
        // The server refused the move: A goes back under Physics.
        {
          id: a?.id ?? "",
          status: "rejected",
          node: sentA ? { ...sentA, parentId: physics.id } : null,
        },
      ],
    });
    expect(notices).toEqual([
      { kind: "renamed", from: sentPhysics?.title, to: "Mechanics 2" },
      { kind: "moved_back", title: "A" },
    ]);
    expect(await titles(physics.id)).toEqual(["A"]);
    expect((await tree.tree()).get(physics.id)?.title).toBe("Mechanics 2");
  });

  it("keeps a node edited while its push was on the way queued", async () => {
    const physics = await tree.createNotebook({ title: "Physics" });
    const pending = await tree.pending();
    await tree.rename(physics.id, "Physics I");
    await tree.applyResults(pending, {
      results: [{ id: physics.id, status: "saved", node: pending.nodes[0] ?? null }],
    });
    expect(await queued()).toEqual([`node:${physics.id}`]);
    expect((await tree.tree()).get(physics.id)?.title).toBe("Physics I");
  });

  it("drops a node the server keeps refusing after three tries, and says so", async () => {
    const physics = await tree.createNotebook({ title: "Physics" });
    const refuse = async () => {
      const pending = await tree.pending();
      return tree.applyResults(pending, {
        results: [{ id: physics.id, status: "rejected", node: null }],
      });
    };
    expect(await refuse()).toEqual([]);
    expect(await refuse()).toEqual([]);
    expect(await refuse()).toEqual([{ kind: "not_saved", title: "Physics" }]);
    expect(await queued()).toEqual([]);
    expect((await tree.tree()).get(physics.id)).toBeDefined(); // still on this device
  });

  it("takes in another device's later edits and new nodes, never over a queued change", async () => {
    const physics = await tree.createNotebook({ title: "Physics" });
    const chem = await tree.createNotebook({ title: "Chemistry" });
    await db.treeOutbox.delete(physics.id); // synced; Chemistry still has a change to send
    const elsewhere = crypto.randomUUID();
    await tree.applyServerTree([
      wire(physics, { title: "Physics (tablet)", editedAt: physics.editedAt + 10 }),
      wire(chem, { title: "Chemistry (tablet)", editedAt: chem.editedAt + 10 }),
      wire(physics, { id: elsewhere, title: "Biology", position: "a5" }),
    ]);
    expect(await titles(null)).toEqual(["Physics (tablet)", "Chemistry", "Biology"]);
  });

  it("sends again a node the server doesn't have", async () => {
    const physics = await tree.createNotebook({ title: "Physics" });
    await db.treeOutbox.clear();
    await tree.applyServerTree([]);
    expect(await queued()).toEqual([`node:${physics.id}`]);
  });
});

describe("upgrading a notebook store from before the tree", () => {
  it("makes every notebook a root, in order, with unique names, queued for the server", async () => {
    const name = databaseName(`upgrade_${++users}`);
    const old = new Dexie(name);
    old.version(3).stores({
      notebooks: "id, updatedAt",
      pages: "id, notebookId, [notebookId+index]",
      strokes: "id, pageId",
      images: "id, pageId, clipId",
      noteLines: "id, pageId",
    });
    const rows = ["Notebook 1", "Notebook 2", "Notebook 1"].map((title, i) => ({
      id: crypto.randomUUID(),
      title,
      createdAt: i,
      updatedAt: 10 + i,
    }));
    await old.table("notebooks").bulkAdd(rows);
    old.close();

    const upgraded = new NotebookDb(name.replace("mew-notebooks-", ""));
    const nodes = new NotebookTree(await new NotebookRepository(upgraded).tree.nodes());
    expect(nodes.children(null).map((n) => n.title)).toEqual([
      "Notebook 1",
      "Notebook 2",
      "Notebook 1 2",
    ]);
    expect(await upgraded.treeOutbox.count()).toBe(3);
  });
});
