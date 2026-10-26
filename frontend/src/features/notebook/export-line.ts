import type { BBox, Stroke } from "@mew/shared";
import {
  bboxesIntersect,
  currentLine,
  inflateBBox,
  type Line,
  type PageDocument,
  planCrop,
  segmentLines,
  unionBBox,
} from "@mew/ink";

import { paintStrokes } from "./canvas/paint";

export type Raster = { blob: Blob; width: number; height: number };
export type LineCrop = Raster & { line: Line };

/** Lines of the student's handwriting. Highlighter marks annotate lines; they aren't writing. */
export function studentLines(doc: PageDocument): Line[] {
  return segmentLines(doc.all().filter(isHandwriting));
}

function isHandwriting(stroke: Stroke): boolean {
  return stroke.author === "student" && stroke.tool === "pen";
}

/** The strokes belonging to the given lines, in drawing order. */
export function strokesOf(doc: PageDocument, lines: readonly Line[]): Stroke[] {
  const ids = new Set(lines.flatMap((l) => l.strokeIds));
  return doc.all().filter((s) => ids.has(s.id));
}

/**
 * Rasterises strokes to a PNG: dark ink on white, sized for handwriting recognition (the light
 * palette is used regardless of theme).
 */
export async function renderStrokesPng(strokes: readonly Stroke[], bbox: BBox): Promise<Raster> {
  const { region, scale, pixelWidth, pixelHeight } = planCrop(bbox);
  const canvas = new OffscreenCanvas(pixelWidth, pixelHeight);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, pixelWidth, pixelHeight);
  ctx.setTransform(scale, 0, 0, scale, -region[0] * scale, -region[1] * scale);
  paintStrokes(ctx, strokes, false);

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { blob, width: pixelWidth, height: pixelHeight };
}

/**
 * Rasterises the line the student wrote in most recently. Only the line's own strokes are
 * drawn: ink from neighbouring lines poking into the box would confuse recognition. With
 * `marks`, the live annotations beside it that it says are shown are drawn too (an export).
 * Returns null when the page has no student writing.
 */
export async function cropCurrentLine(
  doc: PageDocument,
  options: { marks?: (stroke: Stroke) => boolean } = {},
): Promise<LineCrop | null> {
  const line = currentLine(studentLines(doc));
  if (!line) return null;
  // K9: the export shows the line as the student sees it, with its marks (tick, circle, note).
  const near = inflateBBox(line.bbox, line.bbox[3]);
  const marks = options.marks
    ? doc.all().filter((s) => options.marks?.(s) && s.markKind && bboxesIntersect(s.bbox, near))
    : [];
  const strokes = [...strokesOf(doc, [line]), ...marks];
  const box = marks.reduce((b, s) => unionBBox(b, s.bbox), line.bbox);
  return { line, ...(await renderStrokesPng(strokes, box)) };
}

/** Base64 (no data: prefix) of a blob, for JSON request bodies. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
