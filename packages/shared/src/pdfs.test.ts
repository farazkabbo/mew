import { describe, expect, it } from "vitest";

import { parsePageRange, PdfInfo, planImport } from "./pdfs";

const book = {
  pageCount: 120,
  outline: [
    { title: "Chapter 1 Atoms", pageIndex: 4 },
    { title: "Chapter 2 Bonding", pageIndex: 30 },
    { title: "Chapter 3 Reactions", pageIndex: 61 },
  ],
};

describe("planning a PDF import (K4 §5.1)", () => {
  it("splits into chapters by the outline, with the front matter in the destination", () => {
    expect(planImport(book, { first: 1, last: 120 }, true)).toEqual({
      loose: { firstPage: 1, lastPage: 4 },
      chapters: [
        { title: "Chapter 1 Atoms", firstPage: 5, lastPage: 30 },
        { title: "Chapter 2 Bonding", firstPage: 31, lastPage: 61 },
        { title: "Chapter 3 Reactions", firstPage: 62, lastPage: 120 },
      ],
    });
  });

  it("follows a page range, renames and leaves out unchecked chapters", () => {
    const plan = planImport(book, { first: 40, last: 70 }, true, {
      titles: new Map([[2, "Reactions"]]),
    });
    expect(plan).toEqual({
      loose: { firstPage: 40, lastPage: 61 },
      chapters: [{ title: "Reactions", firstPage: 62, lastPage: 70 }],
    });
    expect(
      planImport(book, { first: 1, last: 120 }, true, { skip: new Set([1]) }).chapters.map(
        (c) => c.title,
      ),
    ).toEqual(["Chapter 1 Atoms", "Chapter 3 Reactions"]);
  });

  it("puts every page in the destination without splitting (or without an outline)", () => {
    const all = { loose: { firstPage: 3, lastPage: 9 }, chapters: [] };
    expect(planImport(book, { first: 3, last: 9 }, false)).toEqual(all);
    expect(planImport({ pageCount: 12, outline: [] }, { first: 3, last: 9 }, true)).toEqual(all);
  });

  it("reads page ranges", () => {
    expect(parsePageRange("", 120)).toEqual({ first: 1, last: 120 });
    expect(parsePageRange("40–62", 120)).toEqual({ first: 40, last: 62 });
    expect(parsePageRange("40 - 62", 120)).toEqual({ first: 40, last: 62 });
    expect(parsePageRange("7", 120)).toEqual({ first: 7, last: 7 });
    for (const bad of ["0-3", "62-40", "1-121", "abc", "5,7"]) {
      expect(parsePageRange(bad, 120), bad).toBeNull();
    }
  });

  it("reads an import's answer", () => {
    const info = PdfInfo.parse({
      pdfId: "77777777-7777-4777-8777-777777777777",
      fileName: "Chemistry.pdf",
      pageCount: 2,
      outline: [],
      pageSizes: [
        [612, 792],
        [612, 792],
      ],
    });
    expect(info.courseId).toBeNull();
  });
});
