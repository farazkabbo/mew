import "fake-indexeddb/auto";

import { planImport } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

import { NotebookDb } from "../notebook/db";
import { NotebookRepository } from "../notebook/repository";
import { carryOutImport } from "./import";

const PDF = "77777777-7777-4777-8777-777777777777";
const COURSE = "88888888-8888-4888-8888-888888888888";
let n = 0;

const info = {
  pdfId: PDF,
  fileName: "Chemistry.pdf",
  pageCount: 12,
  courseId: null,
  outline: [
    { title: "Atoms", pageIndex: 2 },
    { title: "Bonding", pageIndex: 7 },
  ],
  pageSizes: Array.from({ length: 12 }, () => [612, 792] as [number, number]),
};

async function setup() {
  const repo = new NotebookRepository(new NotebookDb(`import_${++n}`));
  vi.spyOn(repo.pdfCache, "keep").mockResolvedValue(0);
  const notebook = await repo.tree.createNotebook({ title: "Chemistry" });
  return { repo, notebook };
}

describe("importing a PDF into a notebook (K4 §5.1)", () => {
  it("makes a chapter per outline entry with its pages, and a course for a notebook without one", async () => {
    const { repo, notebook } = await setup();
    const makeCourseMaterial = vi.fn(() => Promise.resolve(COURSE));
    const result = await carryOutImport(
      info,
      {
        nodeId: notebook.id,
        plan: planImport(info, { first: 1, last: 12 }, true),
        courseMaterial: true,
      },
      { repo, tree: await repo.tree.tree(), makeCourseMaterial },
    );
    const tree = await repo.tree.tree();
    const [atoms, bonding] = tree.children(notebook.id);
    expect([atoms?.title, bonding?.title]).toEqual(["Atoms", "Bonding"]);
    // The notebook's own first page, then pages 1–2 (before the first chapter).
    expect((await repo.listPages(notebook.id)).length).toBe(3);
    const atomPages = await repo.listPages(atoms?.id ?? "");
    expect(atomPages).toHaveLength(5); // pages 3–7, with no empty first page
    const [picture] = await repo.loadImages(atomPages[0]?.id ?? "");
    expect(picture?.pdf).toEqual({ pdfId: PDF, pageIndex: 2 });
    expect(picture?.height).toBeCloseTo((picture?.width ?? 0) * (792 / 612));
    expect(await repo.listPages(bonding?.id ?? "")).toHaveLength(5); // pages 8–12

    // The course: every chapter as a section, linked to the notebook.
    expect(makeCourseMaterial).toHaveBeenCalledWith(PDF, {
      courseId: null,
      title: "Chemistry",
      sections: [
        { nodeId: notebook.id, firstPage: 1, lastPage: 2 },
        { nodeId: atoms?.id, firstPage: 3, lastPage: 7 },
        { nodeId: bonding?.id, firstPage: 8, lastPage: 12 },
      ],
    });
    expect(result.courseId).toBe(COURSE);
    expect((await repo.tree.tree()).get(notebook.id)?.courseId).toBe(COURSE);
    // The first ten pages are drawn now.
    expect(repo.pdfCache.keep).toHaveBeenCalledWith(PDF, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("puts a page range into the node when not splitting, and can skip the course", async () => {
    const { repo, notebook } = await setup();
    const makeCourseMaterial = vi.fn();
    const result = await carryOutImport(
      info,
      {
        nodeId: notebook.id,
        plan: planImport(info, { first: 4, last: 6 }, false),
        courseMaterial: false,
      },
      { repo, tree: await repo.tree.tree(), makeCourseMaterial },
    );
    expect((await repo.tree.tree()).children(notebook.id)).toEqual([]);
    expect(await repo.listPages(notebook.id)).toHaveLength(4);
    expect(makeCourseMaterial).not.toHaveBeenCalled();
    expect(result.firstPageId).not.toBeNull();
  });

  it("keeps the pages when the course can't be made", async () => {
    const { repo, notebook } = await setup();
    const result = await carryOutImport(
      info,
      {
        nodeId: notebook.id,
        plan: planImport(info, { first: 1, last: 2 }, false),
        courseMaterial: true,
      },
      {
        repo,
        tree: await repo.tree.tree(),
        makeCourseMaterial: () => Promise.reject(new Error("down")),
      },
    );
    expect(result).toMatchObject({ courseFailed: true, courseId: null });
    expect(await repo.listPages(notebook.id)).toHaveLength(3);
  });
});
