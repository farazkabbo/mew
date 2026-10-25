import { generateKeyBetween } from "fractional-indexing";
import { describe, expect, it } from "vitest";

import { Notebook } from "./notebook";
import {
  childTitles,
  cleanTitle,
  fromNodeSync,
  NotebookTree,
  suggestStyle,
  toNodeSync,
  TREE_LIMITS,
  type TreeNode,
} from "./notebook-tree";

const DAY = 24 * 60 * 60 * 1000;

let next = 0;
/** Each new node sorts after the previous one. */
let lastKey: string | null = null;
function node(title: string, parentId: string | null = null, extra: Partial<TreeNode> = {}) {
  next++;
  return {
    id: `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`,
    title,
    parentId,
    position: (lastKey = generateKeyBetween(lastKey, null)),
    ...extra,
  } satisfies TreeNode;
}

/** Physics › Kinematics › Projectiles, Physics › Forces, and Chemistry. */
function sample() {
  const physics = node("Physics");
  const kinematics = node("Kinematics", physics.id);
  const projectiles = node("Projectiles", kinematics.id);
  const forces = node("Forces", physics.id);
  const chemistry = node("Chemistry");
  return { physics, kinematics, projectiles, forces, chemistry };
}

describe("the notebook tree", () => {
  it("lists children in order, finds paths and depths", () => {
    const s = sample();
    const tree = new NotebookTree(Object.values(s));
    expect(tree.children(null).map((n) => n.title)).toEqual(["Physics", "Chemistry"]);
    expect(tree.children(s.physics.id).map((n) => n.title)).toEqual(["Kinematics", "Forces"]);
    expect(tree.path(s.projectiles.id).map((n) => n.title)).toEqual([
      "Physics",
      "Kinematics",
      "Projectiles",
    ]);
    expect(tree.depth(s.projectiles.id)).toBe(2);
    expect(tree.height(s.physics.id)).toBe(2);
    expect(tree.descendants(s.physics.id)).toHaveLength(3);
  });

  it("allows moves within three levels and refuses deeper ones and loops", () => {
    const s = sample();
    const tree = new NotebookTree(Object.values(s));
    expect(tree.canMove(s.forces.id, s.chemistry.id)).toEqual({ ok: true });
    expect(tree.canMove(s.kinematics.id, null)).toEqual({ ok: true });
    // Kinematics has a section: under Forces it would be a fourth level.
    expect(tree.canMove(s.kinematics.id, s.forces.id)).toEqual({ ok: false, reason: "depth" });
    expect(tree.canMove(s.physics.id, s.projectiles.id)).toEqual({ ok: false, reason: "cycle" });
    expect(tree.canMove(s.physics.id, s.physics.id)).toEqual({ ok: false, reason: "cycle" });
  });

  it("keeps sibling names unique ignoring case, and numbers a clash", () => {
    const s = sample();
    const tree = new NotebookTree(Object.values(s));
    expect(tree.nameTaken(null, "physics")).toBe(true);
    expect(tree.nameTaken(s.chemistry.id, "Physics")).toBe(false);
    expect(tree.nameTaken(null, "Physics", s.physics.id)).toBe(false); // renaming itself
    expect(tree.freeName(null, "PHYSICS")).toBe("PHYSICS 2");
    const withTwo = new NotebookTree([...Object.values(s), node("Physics 2")]);
    expect(withTwo.freeName(null, "Physics")).toBe("Physics 3");
  });

  it("ignores trashed siblings for names and lists, but keeps them for the trash", () => {
    const s = sample();
    const trashed = { ...s.chemistry, deletedAt: 1000 };
    const tree = new NotebookTree([...Object.values(s).filter((n) => n !== s.chemistry), trashed]);
    expect(tree.children(null).map((n) => n.title)).toEqual(["Physics"]);
    expect(tree.nameTaken(null, "Chemistry")).toBe(false);
    expect(tree.trash().map((n) => n.title)).toEqual(["Chemistry"]);
    expect(tree.isLive(trashed.id)).toBe(false);
  });

  it("shows only the top trashed node, and purges it with its children after 30 days", () => {
    const s = sample();
    const now = 100 * DAY;
    const physics = { ...s.physics, deletedAt: now - TREE_LIMITS.trashDays * DAY };
    const forces = { ...s.forces, deletedAt: now - 40 * DAY }; // trashed before its notebook
    const tree = new NotebookTree([physics, s.kinematics, s.projectiles, forces, s.chemistry]);
    expect(tree.trash().map((n) => n.title)).toEqual(["Physics"]);
    expect(tree.isLive(s.projectiles.id)).toBe(false);
    expect(new Set(tree.expired(now))).toEqual(
      new Set([physics.id, s.kinematics.id, s.projectiles.id, forces.id]),
    );
    expect(tree.expired(now - 1)).toEqual([]);
  });

  it("places nodes between siblings with fractional keys", () => {
    const s = sample();
    const tree = new NotebookTree(Object.values(s));
    const first = tree.positionAt(s.physics.id, 0);
    const middle = tree.positionAt(s.physics.id, 1);
    const last = tree.positionAt(s.physics.id, 99);
    expect(first < s.kinematics.position).toBe(true);
    expect(middle > s.kinematics.position && middle < s.forces.position).toBe(true);
    expect(last > s.forces.position).toBe(true);
    // Moving Forces first: placed before Kinematics, ignoring itself.
    expect(tree.positionAt(s.physics.id, 0, s.forces.id) < s.kinematics.position).toBe(true);
    const [a = "", b = ""] = tree.positionsAtEnd(null, 2);
    expect(a > s.chemistry.position && b > a).toBe(true);
  });

  it("never throws on a malformed key from elsewhere: the node lands at that end", () => {
    const bad = node("Bad", null, { position: "a30" });
    const tree = new NotebookTree([bad]);
    expect(tree.positionAt(null, 1)).toMatch(/^[0-9A-Za-z]+$/);
    expect(tree.positionsAtEnd(null, 2)).toHaveLength(2);
  });

  it("puts new nodes after trashed siblings too, so a restored one keeps its place", () => {
    const old = { ...node("Old"), deletedAt: 5 };
    const [next = ""] = new NotebookTree([old]).positionsAtEnd(null, 1);
    expect(next > old.position).toBe(true);
  });

  it("still places a node when two siblings share a key (moved on two devices)", () => {
    const one = node("One", null, { position: "a1" });
    const two = node("Two", null, { position: "a1" });
    const tree = new NotebookTree([one, two]);
    expect(tree.positionAt(null, 1) > "a1").toBe(true);
  });

  it("shows a node whose parent it doesn't know at the top level", () => {
    const orphan = node("Orphan", "00000000-0000-4000-8000-999999999999");
    expect(new NotebookTree([orphan]).children(null).map((n) => n.title)).toEqual(["Orphan"]);
  });
});

describe("titles and styles", () => {
  it("cleans titles and refuses empty or long ones", () => {
    expect(cleanTitle("  Physics   2 ")).toBe("Physics 2");
    expect(cleanTitle("   ")).toBeNull();
    expect(cleanTitle("x".repeat(81))).toBeNull();
  });

  it("names new children by the notebook's label", () => {
    expect(childTitles(3, "Chapters")).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
    expect(childTitles(2, "Units", 5)).toEqual(["Unit 5", "Unit 6"]);
    expect(childTitles(500, "Weeks")).toHaveLength(TREE_LIMITS.chaptersAtCreation);
    expect(childTitles(-1, "Topics")).toEqual([]);
  });

  it("suggests an icon and colour from the name", () => {
    expect(suggestStyle("Physics")).toEqual({ icon: "atom", color: "teal" });
    expect(suggestStyle("Organic Chemistry II")).toEqual({ icon: "flask", color: "violet" });
    expect(suggestStyle("EECS 3221")).toEqual({ icon: "code", color: "slate" });
    expect(suggestStyle("Diary")).toEqual({ icon: "book", color: "slate" });
  });
});

describe("sync records", () => {
  it("round-trips a node, keeping the local recency", () => {
    const local = Notebook.parse({
      id: "00000000-0000-4000-8000-000000000001",
      title: "Physics",
      icon: "atom",
      deletedAt: 5,
      editedAt: 10,
      createdAt: 1,
      updatedAt: 2,
    });
    const wire = toNodeSync(local);
    expect(wire).toMatchObject({
      parentId: null,
      color: null,
      deletedAt: 5,
      childLabel: "Chapters",
    });
    expect(fromNodeSync({ ...wire, title: "Physics II" }, local, 99)).toEqual({
      ...local,
      title: "Physics II",
    });
    expect(fromNodeSync(wire, undefined, 99)).toMatchObject({ createdAt: 10, updatedAt: 10 });
    expect(fromNodeSync({ ...wire, editedAt: 0 }, undefined, 99)).toMatchObject({ updatedAt: 99 });
  });

  it("parses notebooks stored before the tree as roots", () => {
    const old = Notebook.parse({
      id: "00000000-0000-4000-8000-000000000001",
      title: "My first notebook",
      createdAt: 1,
      updatedAt: 2,
    });
    expect(old).toMatchObject({ parentId: null, position: "a0", childLabel: "Chapters" });
  });
});
