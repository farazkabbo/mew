import type { Stroke } from "@mew/shared";
import { currentLine, type Line, type PageDocument, planCrop, segmentLines } from "@mew/ink";

import { paintStrokes } from "./canvas/paint";

export type LineCrop = { line: Line; blob: Blob; width: number; height: number };

/** Lines of the student's handwriting. Highlighter marks annotate lines; they aren't writing. */
export function studentLines(doc: PageDocument): Line[] {
  return segmentLines(doc.all().filter(isHandwriting));
}

function isHandwriting(stroke: Stroke): boolean {
  return stroke.author === "student" && stroke.tool === "pen";
}

/**
 * Rasterises the line the student wrote in most recently to a PNG: dark ink on white, sized for
 * handwriting recognition. Returns null when the page has no student writing.
 */
export async function cropCurrentLine(doc: PageDocument): Promise<LineCrop | null> {
  const line = currentLine(studentLines(doc));
  if (!line) return null;

  const { region, scale, pixelWidth, pixelHeight } = planCrop(line.bbox);
  const canvas = new OffscreenCanvas(pixelWidth, pixelHeight);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, pixelWidth, pixelHeight);
  ctx.setTransform(scale, 0, 0, scale, -region[0] * scale, -region[1] * scale);
  // Only the line's own strokes: ink from neighbouring lines poking into the box would confuse
  // recognition.
  const strokes = line.strokeIds.map((id) => doc.get(id)).filter((s) => s !== undefined);
  paintStrokes(ctx, strokes, false);

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { line, blob, width: pixelWidth, height: pixelHeight };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
