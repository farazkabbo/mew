import { assignLineIds, fnv1a, type Line, lineContentHash } from "@mew/ink";
import type { BBox, ImageBlock, Recognition, Stroke } from "@mew/shared";

import { cleanLineText, type LocalNoteLine } from "./local-lines";

/** Clip text lines kept per clip (a slide rarely has more). */
const MAX_CLIP_LINES = 120;

export type InkLine = { line: Line; strokes: readonly Stroke[] };

export type PageLinesInput = {
  pageId: string;
  /** The student's handwriting, segmented into lines, with each line's strokes. */
  ink: readonly InkLine[];
  /** Clips on the page: their text counts as notes too (never as the student's mistakes). */
  images: readonly ImageBlock[];
  /** What this device stored for the page last time. */
  stored: readonly LocalNoteLine[];
  /** A recognition this session already has for a line (e.g. made for the tutor): free. */
  known: (line: Line) => Recognition | undefined;
  newId: () => string;
};

export type PageLinesPlan = {
  /** The page's line records from now on, including lines that are gone but still on the server. */
  lines: LocalNoteLine[];
  /** Records to delete: gone, and the server never had them. */
  drop: string[];
  /** Each current ink line with its lasting id, in the order given. */
  ink: { id: string; line: Line }[];
  /** Ink lines that need recognising, most recently written first. */
  toRecognize: { id: string; line: Line; contentHash: string }[];
};

/**
 * Works out a page's line records from what's on it now and what was stored before (pure: no
 * storage, no network). Ink lines keep their ids (`assignLineIds`) and their recognition while
 * their strokes are unchanged; clip lines come from each clip's text, one per OCR line. Lines
 * are numbered in reading order, top to bottom.
 */
export function planPageLines(input: PageLinesInput): PageLinesPlan {
  const { pageId, stored } = input;
  const byId = new Map(stored.map((s) => [s.id, s]));
  const liveInk = stored.filter((s) => s.source === "ink" && !s.removed);

  const identified = assignLineIds(
    liveInk.map((s) => ({ id: s.id, strokeIds: s.strokeIds })),
    input.ink.map((ink) => ({
      ...ink,
      strokeIds: ink.line.strokeIds,
      firstCreatedAt: ink.line.firstCreatedAt,
    })),
    input.newId,
  );

  const toRecognize: PageLinesPlan["toRecognize"] = [];
  const next: LocalNoteLine[] = identified.lines.map(({ line: ink, id }) => {
    const previous = byId.get(id);
    const contentHash = lineContentHash(ink.strokes);
    const recognition =
      previous && previous.contentHash === contentHash && previous.recognition
        ? previous.recognition
        : cleanRecognition(input.known(ink.line));
    if (!recognition) toRecognize.push({ id, line: ink.line, contentHash });
    return {
      id,
      pageId,
      source: "ink",
      strokeIds: [...ink.line.strokeIds],
      bbox: ink.line.bbox,
      lineIndex: 0,
      contentHash,
      recognition,
      synced: previous?.synced ?? "",
      removed: false,
    };
  });

  for (const image of input.images) next.push(...clipLines(image, pageId, stored, input.newId));

  numberInReadingOrder(next);

  const current = new Set(next.map((l) => l.id));
  const drop: string[] = [];
  for (const old of stored) {
    if (current.has(old.id)) continue;
    // A line the server never had can simply go; one it has stays until the server drops it.
    if (old.synced === "") drop.push(old.id);
    else next.push({ ...old, removed: true });
  }

  toRecognize.sort((a, b) => b.line.lastCreatedAt - a.line.lastCreatedAt);
  const ink = identified.lines.map(({ line, id }) => ({ id, line: line.line }));
  return { lines: next, drop, ink, toRecognize };
}

/** The text of a clip, as lines (OCR lines are separated by newlines). */
function clipLines(
  image: ImageBlock,
  pageId: string,
  stored: readonly LocalNoteLine[],
  newId: () => string,
): LocalNoteLine[] {
  const texts = (image.ocrText ?? "")
    .split("\n")
    .map((t) => cleanLineText(t))
    .filter((t) => t !== "")
    .slice(0, MAX_CLIP_LINES);
  const before = stored.filter(
    (s) => s.source === "clip" && s.clipId === image.clipId && !s.removed,
  );
  // Until the desktop app sends a box per OCR line (N4), each line has the clip's box.
  const bbox: BBox = [image.x, image.y, image.width, image.height];
  return texts.map((text, clipLine) => {
    const previous = before.find((s) => s.clipLine === clipLine);
    return {
      id: previous?.id ?? newId(),
      pageId,
      source: "clip",
      strokeIds: [],
      clipId: image.clipId,
      clipLine,
      bbox,
      lineIndex: 0,
      contentHash: fnv1a(`${image.clipId}:${clipLine}:${text}`),
      recognition: { text, latex: null, subject: "other", confidence: 1 },
      synced: previous?.synced ?? "",
      removed: false,
    };
  });
}

/** Numbers lines top to bottom, then left to right (clip lines in their own order). */
function numberInReadingOrder(lines: LocalNoteLine[]): void {
  const order = [...lines].sort(
    (a, b) =>
      a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0] || (a.clipLine ?? 0) - (b.clipLine ?? 0),
  );
  order.forEach((line, index) => {
    line.lineIndex = index;
  });
}

/** A recognition with its text made safe to store and sync. */
export function cleanRecognition(recognition: Recognition | undefined | null): Recognition | null {
  if (!recognition) return null;
  return {
    ...recognition,
    text: cleanLineText(recognition.text),
    latex: recognition.latex === null ? null : cleanLineText(recognition.latex),
  };
}
