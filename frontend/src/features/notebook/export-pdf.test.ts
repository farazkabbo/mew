import { readFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";

import type { ImageBlock, Stroke } from "@mew/shared";
import { PDFDocument, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { buildMomentsPdf, collectMoments, type PdfMoment, strokesOver } from "./export-pdf";

/** A 1 × 1 white PNG: what the browser would draw the words as. */
const WHITE_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const renderText = async (lines: readonly unknown[]) => ({
  png: WHITE_PNG,
  width: 1000,
  height: 40 * lines.length,
});
const JPEG = Uint8Array.from(
  readFileSync(path.join(import.meta.dirname, "../../../evals/tokens/maths-focus.jpg")),
);

const moment = (turns: PdfMoment["turns"]): PdfMoment => ({
  title: "Algebra · From screen",
  date: new Date(2026, 10, 8),
  image: { bytes: JPEG, mime: "image/jpeg", width: 560, height: 120 },
  strokes: [
    {
      color: "#6b4ee6",
      width: 0.004,
      points: [
        [0.1, 0.8],
        [0.5, 0.85],
        [0.9, 0.8],
      ],
    },
  ],
  turns,
});

const TURN = {
  question: "explain",
  steps: ["Take 7 from both sides.", "Then divide by 3."],
  summary: "Undo each step in reverse.",
  followUpQuestion: "What would you do first with 2x − 5 = 9?",
};

/** The document's drawing commands, decompressed. */
async function drawing(bytes: Uint8Array): Promise<string> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.context
    .enumerateIndirectObjects()
    .map(([, object]) => object)
    .filter((object): object is PDFRawStream => object instanceof PDFRawStream)
    .map((stream) => {
      try {
        return inflateSync(stream.contents).toString("latin1");
      } catch {
        return Buffer.from(stream.contents).toString("latin1");
      }
    })
    .join(" ");
}

describe("saved moments as a PDF", () => {
  it("gives each moment a page, with the picture and the ink as vector paths", async () => {
    const bytes = await buildMomentsPdf([moment([TURN]), moment([TURN])], renderText);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(2);
    const drawn = await drawing(bytes);
    // The ink: a path moved to and lined through, stroked in the tutor's violet.
    expect(drawn).toMatch(/ m\b/);
    expect(drawn).toMatch(/ l\b/);
    expect(drawn).toMatch(/0\.41\d* 0\.30\d* 0\.90\d* RG/);
  });

  it("carries a long explanation onto the next page", async () => {
    const long = { ...TURN, steps: Array.from({ length: 5 }, (_, i) => `Step ${i}`) };
    const tall = async () => ({ png: WHITE_PNG, width: 1000, height: 1400 });
    const bytes = await buildMomentsPdf([moment([long, long, long])], tall);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
  });

  it("takes only the entry's own ink, as fractions of its picture", () => {
    const image = {
      id: "11111111-1111-4111-8111-111111111111",
      x: 100,
      y: 200,
      width: 400,
      height: 100,
      entry: { strokeIds: ["22222222-2222-4222-8222-222222222222"] },
    } as unknown as ImageBlock;
    const stroke = (id: string): Stroke =>
      ({
        id,
        color: "#6b4ee6",
        width: 4,
        points: [
          [100, 200, 0.5, 0],
          [500, 300, 0.5, 10],
        ],
        bbox: [100, 200, 400, 100],
      }) as unknown as Stroke;
    const kept = strokesOver(image, [
      stroke("22222222-2222-4222-8222-222222222222"),
      stroke("33333333-3333-4333-8333-333333333333"),
    ]);
    expect(kept).toEqual([
      {
        color: "#6b4ee6",
        width: 0.01,
        points: [
          [0, 0],
          [1, 1],
        ],
      },
    ]);
  });

  it("collects the moments on a page, top to bottom, or just one", async () => {
    const entry = (id: string, y: number) =>
      ({
        id,
        y,
        x: 0,
        width: 10,
        height: 10,
        clipId: "44444444-4444-4444-8444-444444444444",
        createdAt: 0,
        entry: { turns: [TURN], strokeIds: [] },
      }) as unknown as ImageBlock;
    const source = {
      listPages: async () => [],
      loadStrokes: async () => [],
      loadImages: async () => [entry("b", 300), entry("a", 100)],
      clipImage: async () => moment([]).image,
    };
    const all = await collectMoments(source, ["page"], "Algebra");
    expect(all).toHaveLength(2);
    expect(await collectMoments(source, ["page"], "Algebra", "b")).toHaveLength(1);
  });
});
