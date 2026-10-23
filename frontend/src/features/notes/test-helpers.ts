import { type Line, PageDocument, segmentLines, strokeBBox } from "@mew/ink";
import type { ImageBlock, Point, Recognition, Stroke } from "@mew/shared";

import type { InkLine } from "./page-lines";

export const PAGE_ID = "22222222-2222-4222-8222-222222222222";

/** A short horizontal pen stroke at (x, y), written at `createdAt`. */
export function penStroke(x: number, y: number, createdAt: number, points = 2): Stroke {
  const path: Point[] = Array.from({ length: points }, (_, i) => [
    x + (i * 40) / points,
    y,
    0.5,
    i * 16,
  ]);
  return {
    id: crypto.randomUUID(),
    pageId: PAGE_ID,
    author: "student",
    tool: "pen",
    points: path,
    color: "#1d1c1a",
    width: 2,
    bbox: strokeBBox(path, 2),
    createdAt,
  };
}

/** A few words' worth of strokes on one line, starting at `createdAt`. */
export function writtenLine(y: number, createdAt: number, words = 3): Stroke[] {
  return Array.from({ length: words }, (_, i) => penStroke(10 + i * 50, y, createdAt + i * 100));
}

export function inkOf(strokes: readonly Stroke[]): InkLine[] {
  return segmentLines(strokes).map((line) => ({
    line,
    strokes: strokes.filter((s) => line.strokeIds.includes(s.id)),
  }));
}

export function docOf(strokes: readonly Stroke[]): PageDocument {
  return new PageDocument(strokes);
}

export function recognised(text: string, confidence = 0.9): Recognition {
  return { text, latex: null, subject: "biology", confidence };
}

export function clipImage(
  ocrText: string,
  clipId = "77777777-7777-4777-8777-777777777777",
): ImageBlock {
  return {
    id: crypto.randomUUID(),
    pageId: PAGE_ID,
    type: "image",
    clipId,
    x: 0,
    y: 0,
    width: 400,
    height: 200,
    ocrText,
    createdAt: 1,
  };
}

/** Ids from a counter, so tests can name them. */
export function ids(prefix = "00000000-0000-4000-8000-"): () => string {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(12, "0")}`;
}

export type { Line };
