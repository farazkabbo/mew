import { type Camera, type Line, type PageDocument, pointInPolygon, type Vec } from "@mew/ink";
import { type ClippedText, type ImageBlock, type PdfWord, TUTOR_LIMITS } from "@mew/shared";

import { sourceLabel } from "./clip-page";
import { studentLines } from "./export-line";

/** What loops drawn while holding Ctrl+Alt took in: the student's lines and printed PDF text. */
export type Circled = { lines: readonly Line[]; printed: ClippedText | null };

/**
 * The student's lines a loop takes in (K6 §6.3, holding Ctrl+Alt on the page), top to bottom: a
 * line counts when at least half of its strokes are inside, so a loop that clips a neighbour's
 * edge doesn't take that line too.
 */
export function circledLines(doc: PageDocument, loop: readonly Vec[]): Line[] {
  const inside = new Set(doc.inLasso(loop).map((s) => s.id));
  if (inside.size === 0) return [];
  return studentLines(doc)
    .filter((line) => {
      const taken = line.strokeIds.filter((id) => inside.has(id)).length;
      return taken > 0 && taken * 2 >= line.strokeIds.length;
    })
    .sort((a, b) => a.bbox[1] - b.bbox[1]);
}

/**
 * The printed words a loop takes in on a PDF page in neb (K4 §5.2: its text layer, so no
 * screenshot or OCR), in reading order, with the file and page they're from: a word counts when
 * its middle is inside. Null when the loop has none.
 */
export function circledPrinted(
  image: ImageBlock,
  words: readonly PdfWord[],
  loop: readonly Vec[],
): ClippedText | null {
  if (!image.pdf || loop.length < 3) return null;
  const taken = words.filter(({ box: [left, top, right, bottom] }) =>
    pointInPolygon(
      image.x + ((left + right) / 2) * image.width,
      image.y + ((top + bottom) / 2) * image.height,
      loop,
    ),
  );
  if (taken.length === 0) return null;
  return {
    source: sourceLabel(image).slice(0, 200),
    text: taken
      .map((w) => w.text)
      .join(" ")
      .slice(0, TUTOR_LIMITS.clippedTextChars),
  };
}

/** Two loops' printed text from the same page, as one passage (a second loop adds to the first). */
export function joinPrinted(a: ClippedText | null, b: ClippedText | null): ClippedText | null {
  if (!a || !b) return a ?? b;
  if (a.source !== b.source) return b;
  return {
    source: a.source,
    text: `${a.text} … ${b.text}`.slice(0, TUTOR_LIMITS.clippedTextChars),
  };
}

/** A point on screen (CSS px in the canvas) on the page, under the camera. */
export function toPage([x, y]: Vec, camera: Camera): Vec {
  return [x / camera.zoom + camera.x, y / camera.zoom + camera.y];
}
