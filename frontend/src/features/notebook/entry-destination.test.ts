import "fake-indexeddb/auto";

import { strokeBBox } from "@mew/ink";
import { type BBox, ClipView, type Point, type Stroke } from "@mew/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { entrySolutionId, type LocalSolution } from "../solution/record";
import { NotebookDb } from "./db";
import { NotebookRepository } from "./repository";

/** K3: an entry goes where the student said, once, and moves when they change it. */

let db: NotebookDb;
let repo: NotebookRepository;
let n = 0;

beforeEach(() => {
  db = new NotebookDb(`entries_${++n}`);
  repo = new NotebookRepository(db);
});
afterEach(() => vi.useRealTimers());

let clips = 0;
function entry(destination: unknown = null) {
  clips++;
  return ClipView.parse({
    id: `33333333-3333-4333-8333-${String(clips).padStart(12, "0")}`,
    width: 800,
    height: 400,
    pixelRatio: 1,
    strokes: [{ tool: "pen", color: "#8a7bf0", width: 3, points: [[10, 10, 0.5, 0]] }],
    source: { app: "msedge.exe", capturedAt: "2026-10-24T10:00:00.000Z" },
    ocrText: "",
    createdAt: "2026-10-24T10:00:01.000+00:00",
    entry: {
      sessionId: "22222222-2222-4222-8222-222222222222",
      studentStrokes: [{ tool: "pen", color: "#c0392b", width: 3, points: [[5, 5, 0.5, 0]] }],
      turns: [{ question: "Explain this", steps: ["One."], summary: "S." }],
      strokeSteps: [[0, 0]],
      conceptHints: [],
    },
    destination,
  });
}

async function physics() {
  const notebook = await repo.tree.createNotebook({
    title: "Physics",
    chapters: ["Chapter 1", "Chapter 2"],
  });
  const tree = await repo.tree.tree();
  const [ch1, ch2] = tree.children(notebook.id);
  if (!ch1 || !ch2) throw new Error("no chapters");
  return { notebook, ch1, ch2 };
}

async function importIt(clip: ClipView, fallback: string) {
  const target = await repo.destinationOf(clip, fallback);
  const page = await repo.importEntry(target.nodeId, clip, target.page);
  return { page, missing: target.missing };
}

describe("saving an entry where the student said (K3)", () => {
  it("lands on the named chapter's From screen page, not the open notebook", async () => {
    const { notebook, ch2 } = await physics();
    const clip = entry({ nodeId: ch2.id, page: { kind: "from_screen" } });
    const { page, missing } = await importIt(clip, notebook.id);
    expect(missing).toBe(false);
    expect(page.notebookId).toBe(ch2.id);
    expect(page.fromScreen).toBe(1);
    const [image] = await repo.loadImages(page.id);
    expect(image?.entry?.heading).toMatch(/^\w{3} \d{1,2} \w{3}$/);
    // Its strokes are known, so it can move whole later.
    expect(image?.entry?.strokeIds).toHaveLength(2);
  });

  it("makes the chapter the student tapped “Create it and save” for, once", async () => {
    const { notebook } = await physics();
    const clip = entry({
      nodeId: notebook.id,
      page: { kind: "from_screen" },
      create: { title: "Chapter 5" },
    });
    const { page } = await importIt(clip, notebook.id);
    const tree = await repo.tree.tree();
    const made = tree.children(notebook.id).filter((c) => c.title === "Chapter 5");
    expect(made).toHaveLength(1);
    expect(page.notebookId).toBe(made[0]?.id);
    // Another entry for the same new chapter goes there too (no "Chapter 5 2").
    await importIt(
      entry({ nodeId: notebook.id, page: { kind: "from_screen" }, create: { title: "chapter 5" } }),
      notebook.id,
    );
    expect(
      (await repo.tree.tree()).children(notebook.id).filter((c) => /chapter 5/i.test(c.title)),
    ).toHaveLength(1);
  });

  it("moves when the place changes: never two copies", async () => {
    const { notebook, ch1, ch2 } = await physics();
    const clip = entry({ nodeId: ch1.id, page: { kind: "from_screen" } });
    const first = await importIt(clip, notebook.id);
    const moved = await importIt(
      { ...clip, destination: { nodeId: ch2.id, page: { kind: "from_screen" } } },
      notebook.id,
    );
    expect(moved.page.notebookId).toBe(ch2.id);
    expect(await repo.loadImages(first.page.id)).toEqual([]);
    expect(await repo.loadStrokes(first.page.id)).toEqual([]);
    expect(await repo.loadImages(moved.page.id)).toHaveLength(1);
    expect(await repo.loadStrokes(moved.page.id)).toHaveLength(2);
  });

  it("falls back to the open node when the named one isn't on this device", async () => {
    const { notebook } = await physics();
    const clip = entry({
      nodeId: "99999999-9999-4999-8999-999999999999",
      page: { kind: "from_screen" },
    });
    const { page, missing } = await importIt(clip, notebook.id);
    expect(missing).toBe(true);
    expect(page.notebookId).toBe(notebook.id);
  });

  it("stacks a day's entries under one heading, and starts From screen 2 after 30", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 26, 9));
    const { ch1 } = await physics();
    const to = { nodeId: ch1.id, page: { kind: "from_screen" } };
    const a = await importIt(entry(to), ch1.id);
    const b = await importIt(entry(to), ch1.id);
    expect(b.page.id).toBe(a.page.id);
    vi.setSystemTime(new Date(2026, 9, 27, 9));
    const c = await importIt(entry(to), ch1.id);
    const images = (await repo.loadImages(a.page.id)).sort((x, y) => x.y - y.y);
    expect(images.map((i) => i.entry?.heading ?? null)).toEqual(["Mon 26 Oct", null, "Tue 27 Oct"]);
    expect(c.page.id).toBe(a.page.id);

    for (let i = 3; i < 30; i++) await importIt(entry(to), ch1.id);
    const next = await importIt(entry(to), ch1.id);
    expect(next.page.id).not.toBe(a.page.id);
    expect(next.page.fromScreen).toBe(2);
    expect((await repo.loadImages(next.page.id))[0]?.entry?.heading).toBe("Tue 27 Oct");
  });

  it("can go on a new page, or the node's nth page", async () => {
    const { ch1 } = await physics();
    const fresh = await importIt(entry({ nodeId: ch1.id, page: { kind: "new" } }), ch1.id);
    expect(fresh.page.fromScreen).toBeUndefined();
    const [firstPage] = await repo.listPages(ch1.id);
    const second = await importIt(
      entry({ nodeId: ch1.id, page: { kind: "number", number: 1 } }),
      ch1.id,
    );
    expect(second.page.id).toBe(firstPage?.id);
  });
});

describe("filing a moment from the notebook, offline too (K8)", () => {
  it("moves the entry whole to the chapter's From screen page, with nothing fetched", async () => {
    const { ch1, ch2 } = await physics();
    const clip = entry();
    const page = await repo.importEntry(ch1.id, clip);
    const [image] = await repo.loadImages(page.id);
    if (!image) throw new Error("no entry");
    const strokesBefore = await repo.loadStrokes(page.id);
    expect(strokesBefore).toHaveLength(2); // the tutor's step and the student's mark

    const moved = await repo.relocateEntry(image.id, ch2.id);
    if (!moved) throw new Error("not moved");
    expect(moved.notebookId).toBe(ch2.id);
    expect(await repo.loadImages(page.id)).toEqual([]);
    expect(await repo.loadStrokes(page.id)).toEqual([]);
    const [there] = await repo.loadImages(moved.id);
    expect(there).toMatchObject({ id: image.id, clipId: clip.id });
    expect(there?.entry?.heading).toBeDefined(); // the first entry on that page: its day
    const strokesAfter = await repo.loadStrokes(moved.id);
    expect(strokesAfter.map((s) => s.id).sort()).toEqual(strokesBefore.map((s) => s.id).sort());
    // Still where the picture is, relative to it.
    const dy = (there?.y ?? 0) - image.y;
    expect(strokesAfter[0]?.bbox[1]).toBeCloseTo((strokesBefore[0]?.bbox[1] ?? 0) + dy);

    // Moving it where it already is changes nothing.
    expect((await repo.relocateEntry(image.id, ch2.id))?.id).toBe(moved.id);
    expect(await repo.relocateEntry(crypto.randomUUID(), ch2.id)).toBeNull();
  });
});

describe("an entry's worked solution moves with it (K7)", () => {
  const SOLUTION_GROUP = "44444444-4444-4444-8444-000000000001";
  const TURN_GROUP = "44444444-4444-4444-8444-000000000002";
  const BOX: BBox = [80, 900, 600, 300];

  const stroke = (pageId: string, x: number, y: number, extra: Partial<Stroke> = {}): Stroke => {
    const points: Point[] = [
      [x, y, 0.5, 0],
      [x + 20, y + 20, 0.5, 10],
    ];
    return {
      id: crypto.randomUUID(),
      pageId,
      author: "student",
      tool: "pen",
      points,
      color: "#1d1c1a",
      width: 3,
      bbox: strokeBBox(points, 3),
      createdAt: 1,
      ...extra,
    };
  };

  /** An entry on Chapter 1 with its solution written: ink, Your Turn box, an attempt in it. */
  async function solvedEntry() {
    const { notebook, ch1, ch2 } = await physics();
    const clip = entry({ nodeId: ch1.id, page: { kind: "from_screen" } });
    const { page } = await importIt(clip, notebook.id);
    const [image] = await repo.loadImages(page.id);
    if (!image) throw new Error("no entry");
    const tutor = { author: "tutor" as const };
    const solution = [
      stroke(page.id, 100, 700, { ...tutor, groupId: SOLUTION_GROUP }),
      stroke(page.id, 100, 910, { ...tutor, groupId: TURN_GROUP }),
      stroke(page.id, 120, 1000), // the student's attempt, in the box
    ];
    const elsewhere = stroke(page.id, 900, 2000);
    await repo.putStrokes([...solution, elsewhere]);
    const record: LocalSolution = {
      id: entrySolutionId(image.id),
      pageId: page.id,
      createdAt: 1,
      groupId: SOLUTION_GROUP,
      bbox: [80, 680, 400, 100],
      folded: true,
      problem: "3x + 7 = 19",
      courseId: null,
      conceptIds: [],
      yourTurn: {
        problem: "5x − 4 = 21",
        latex: "5x - 4 = 21",
        answerKey: { text: "x = 5", latex: "x = 5" },
        skill: "two-step equations",
        groupId: TURN_GROUP,
        region: BOX,
        peeked: false,
        hinted: false,
        misses: {},
        ticked: [],
        status: "open",
      },
    };
    await db.solutions.put(record);
    return { notebook, ch2, clip, page, image, solution, elsewhere };
  }

  it("goes with an entry filed in the notebook: its ink, its box and the attempt in it", async () => {
    const { ch2, page, image, solution, elsewhere } = await solvedEntry();
    const moved = await repo.relocateEntry(image.id, ch2.id);
    if (!moved) throw new Error("not moved");

    expect((await repo.loadStrokes(page.id)).map((s) => s.id)).toEqual([elsewhere.id]);
    const there = await repo.loadStrokes(moved.id);
    expect(solution.every((s) => there.some((t) => t.id === s.id))).toBe(true);
    const [placed] = await repo.loadImages(moved.id);
    const dy = (placed?.y ?? 0) - image.y;
    const record = await db.solutions.get(entrySolutionId(image.id));
    expect(record?.pageId).toBe(moved.id);
    expect(record?.yourTurn?.region).toEqual([BOX[0], BOX[1] + dy, BOX[2], BOX[3]]);
    expect(await db.solutions.where("pageId").equals(page.id).count()).toBe(0);
  });

  it("goes with an entry moved by a new place from the screen, under its new image", async () => {
    const { notebook, ch2, clip, page, solution } = await solvedEntry();
    const moved = await importIt(
      { ...clip, destination: { nodeId: ch2.id, page: { kind: "from_screen" } } },
      notebook.id,
    );
    const [placed] = await repo.loadImages(moved.page.id);
    if (!placed) throw new Error("not moved");
    expect(await repo.loadStrokes(page.id)).toHaveLength(1); // only what wasn't the entry's
    const there = (await repo.loadStrokes(moved.page.id)).map((s) => s.id);
    expect(solution.every((s) => there.includes(s.id))).toBe(true);
    // Its record now belongs to the new image, so it isn't written a second time there.
    const records = await db.solutions.toArray();
    expect(records.map((r) => [r.id, r.pageId])).toEqual([
      [entrySolutionId(placed.id), moved.page.id],
    ]);
  });
});
