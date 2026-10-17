import "fake-indexeddb/auto";

import type { Point, Stroke } from "@mew/shared";
import { strokeBBox } from "@mew/ink";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NotebookDb } from "./db";
import { PageEngine } from "./engine";
import { NotebookRepository } from "./repository";

let repo: NotebookRepository;
let pageId: string;
let userCounter = 0;

beforeEach(async () => {
  repo = new NotebookRepository(new NotebookDb(`test_${++userCounter}`));
  const notebook = await repo.openLatestNotebook();
  const [page] = await repo.listPages(notebook.id);
  pageId = page?.id ?? "";
});

function stroke(y: number, createdAt: number): Stroke {
  const points: Point[] = [
    [0, y, 0.5, 0],
    [50, y, 0.5, 16],
  ];
  return {
    id: crypto.randomUUID(),
    pageId,
    author: "student",
    tool: "pen",
    points,
    color: "#1d1c1a",
    width: 2,
    bbox: strokeBBox(points, 2),
    createdAt,
  };
}

async function reopen(): Promise<PageEngine> {
  return PageEngine.open(repo, pageId, (e: unknown) => {
    throw e;
  });
}

describe("NotebookRepository", () => {
  it("creates a first notebook with one page, and reuses it afterwards", async () => {
    const again = await repo.openLatestNotebook();
    const notebooks = await repo.listNotebooks();

    expect(notebooks).toHaveLength(1);
    expect(notebooks[0]?.id).toBe(again.id);
    expect(await repo.listPages(again.id)).toHaveLength(1);
  });

  it("creates exactly one first notebook under concurrent opens (StrictMode, two tabs)", async () => {
    const fresh = new NotebookRepository(new NotebookDb(`test_concurrent_${++userCounter}`));
    const opened = await Promise.all([
      fresh.openLatestNotebook(),
      fresh.openLatestNotebook(),
      fresh.openLatestNotebook(),
    ]);

    expect(new Set(opened.map((n) => n.id)).size).toBe(1);
    expect(await fresh.listNotebooks()).toHaveLength(1);
  });

  it("appends pages in index order", async () => {
    const notebook = await repo.openLatestNotebook();
    await repo.addPage(notebook.id);
    await repo.addPage(notebook.id);

    expect((await repo.listPages(notebook.id)).map((p) => p.index)).toEqual([0, 1, 2]);
  });

  it("skips corrupted stroke rows instead of trusting them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const good = stroke(10, 1);
    await repo.putStrokes([
      good,
      { ...good, id: crypto.randomUUID(), color: "javascript:alert(1)" },
    ]);

    expect((await repo.loadStrokes(pageId)).map((s) => s.id)).toEqual([good.id]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("PageEngine", () => {
  it("persists strokes so a reopened page shows them (reload)", async () => {
    const engine = await reopen();
    engine.addStroke(stroke(10, 1));
    engine.addStroke(stroke(30, 2));
    await engine.flush();

    expect((await reopen()).doc.size).toBe(2);
  });

  it("persists undo and redo", async () => {
    const engine = await reopen();
    engine.addStroke(stroke(10, 1));
    engine.addStroke(stroke(30, 2));
    engine.undo();
    await engine.flush();
    expect((await reopen()).doc.size).toBe(1);

    engine.redo();
    await engine.flush();
    expect((await reopen()).doc.size).toBe(2);
  });

  it("turns one eraser gesture into one undo step", async () => {
    const engine = await reopen();
    engine.addStroke(stroke(10, 1));
    engine.addStroke(stroke(30, 2));

    expect(engine.eraseAlong([25, 0], [25, 12], 3)).toBe(true);
    expect(engine.eraseAlong([25, 12], [25, 35], 3)).toBe(true);
    engine.endErase();
    await engine.flush();
    expect((await reopen()).doc.size).toBe(0);

    engine.undo();
    await engine.flush();
    expect((await reopen()).doc.size).toBe(2);
  });

  it("notifies subscribers on changes", async () => {
    const engine = await reopen();
    const listener = vi.fn();
    engine.subscribe(listener);

    engine.addStroke(stroke(10, 1));
    engine.undo();

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("reports storage failures instead of throwing into the UI", async () => {
    const onError = vi.fn();
    const engine = await PageEngine.open(repo, pageId, onError);
    vi.spyOn(repo, "putStrokes").mockRejectedValueOnce(new Error("quota exceeded"));

    engine.addStroke(stroke(10, 1));
    await engine.flush();

    expect(onError).toHaveBeenCalledOnce();
  });
});
