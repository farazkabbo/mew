import { PageDocument, strokeBBox, type Vec } from "@mew/ink";
import type { ImageBlock, PdfWord, Point, Stroke } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { circledLines, circledPrinted, joinPrinted, toPage } from "./circle";

let n = 0;
function stroke(x: number, y: number, author: Stroke["author"] = "student"): Stroke {
  const points: Point[] = [
    [x, y + 24, 0.5, 0],
    [x + 8, y, 0.5, 10],
    [x + 16, y + 24, 0.5, 20],
  ];
  n++;
  return {
    id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
    pageId: "00000000-0000-4000-8000-0000000000aa",
    author,
    tool: "pen",
    points,
    color: "#1d1c1a",
    width: 3,
    bbox: strokeBBox(points, 3),
    createdAt: n,
  };
}

const written = (y: number, letters = 4) =>
  Array.from({ length: letters }, (_, i) => stroke(100 + i * 20, y));

/** A rectangle as a hand-drawn loop would be (closed implicitly). */
const loop = (x: number, y: number, w: number, h: number): Vec[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

describe("circledLines", () => {
  it("takes the lines inside the loop, top to bottom", () => {
    const doc = new PageDocument([...written(300), ...written(100), ...written(200)]);
    const lines = circledLines(doc, loop(80, 80, 200, 160));
    expect(lines).toHaveLength(2);
    expect(lines[0]?.bbox[1]).toBeLessThan(lines[1]?.bbox[1] ?? 0);
  });

  it("doesn't take a neighbour the loop only clips", () => {
    const doc = new PageDocument([...written(100), ...written(200)]);
    // All of the first line, and only the first letter of the second.
    const lines = circledLines(doc, loop(80, 80, 200, 60));
    expect(lines).toHaveLength(1);
    const clipped = circledLines(doc, [
      [80, 80],
      [200, 80],
      [200, 140],
      [125, 140],
      [125, 240],
      [80, 240],
    ]);
    expect(clipped).toHaveLength(1);
  });

  it("finds nothing in an empty loop, and never the tutor's ink", () => {
    const doc = new PageDocument([stroke(100, 100, "tutor"), stroke(120, 100, "tutor")]);
    expect(circledLines(doc, loop(80, 80, 200, 60))).toEqual([]);
    expect(circledLines(doc, [[0, 0]])).toEqual([]);
  });
});

describe("circledPrinted (K4 §5.2: circling a PDF page in neb)", () => {
  // A 600 × 800 page drawn at (40, 100): a word's middle at (0.5, 0.25) is at (340, 300).
  const page = {
    id: "33333333-3333-4333-8333-000000000001",
    pageId: "00000000-0000-4000-8000-0000000000aa",
    type: "image",
    pdf: { pdfId: "77777777-7777-4777-8777-777777777777", pageIndex: 3 },
    x: 40,
    y: 100,
    width: 600,
    height: 800,
    source: { app: "neb", title: "chem.pdf · page 4", capturedAt: "x" },
    createdAt: 1,
  } as ImageBlock;
  const word = (text: string, left: number, top: number): PdfWord => ({
    text,
    box: [left, top, left + 0.1, top + 0.02],
  });
  const words = [
    word("Benzene", 0.1, 0.24),
    word("is", 0.25, 0.24),
    word("aromatic.", 0.4, 0.24),
    word("Footnote", 0.1, 0.9),
  ];
  const around = (x0: number, y0: number, x1: number, y1: number): Vec[] => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];

  it("takes the words whose middle is in the loop, with the file and page", () => {
    expect(circledPrinted(page, words, around(80, 280, 420, 320))).toEqual({
      source: "chem.pdf · page 4",
      text: "Benzene is aromatic.",
    });
  });

  it("takes nothing outside the loop, or on a page that isn't a PDF's", () => {
    expect(circledPrinted(page, words, around(0, 0, 30, 30))).toBeNull();
    expect(
      circledPrinted({ ...page, pdf: undefined }, words, around(80, 280, 420, 320)),
    ).toBeNull();
  });

  it("joins two loops on one page, and keeps the newer page's", () => {
    const a = { source: "chem.pdf · page 4", text: "Benzene" };
    const b = { source: "chem.pdf · page 4", text: "aromatic." };
    expect(joinPrinted(a, b)?.text).toBe("Benzene … aromatic.");
    expect(joinPrinted(a, { ...b, source: "chem.pdf · page 5" })).toEqual({
      ...b,
      source: "chem.pdf · page 5",
    });
    expect(joinPrinted(null, b)).toBe(b);
  });
});

describe("toPage", () => {
  it("undoes the camera's zoom and pan", () => {
    expect(toPage([200, 100], { x: 50, y: 20, zoom: 2 })).toEqual([150, 70]);
    expect(toPage([10, 10], { x: 0, y: 0, zoom: 1 })).toEqual([10, 10]);
  });
});
