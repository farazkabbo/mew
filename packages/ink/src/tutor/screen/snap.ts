import type { BBox } from "@mew/shared";

import { unionBBox } from "../../geometry";

/**
 * Snapping the model's targets onto the words on screen. The model reads coordinates off a
 * downscaled picture, so its boxes and points are often a little off: an underline half a line
 * too high runs through the words (it looks crossed out), and an arrow lands beside the word it
 * means. The device knows where every word is (OCR boxes), so a target that's clearly about text
 * is moved onto that text; one that isn't (a figure, empty space) is left as it was.
 *
 * Everything is in overlay pixels, like the planner.
 */

/** A word counts as covered when this much of it is inside the (slightly grown) target. */
const COVERED = 0.5;
/** A circle snaps only when its words fill at least this much of it (else it's a figure). */
const TEXT_FILL = 0.35;
/** …and the snapped box keeps at least this much of the model's box (no wild jumps). */
const KEEP = 0.4;
/** An arrow's tip moves onto a word at most this many word heights away. */
const POINT_REACH = 1.2;

/** Typical word height (median), or 0 with no words. */
function wordHeight(words: readonly BBox[]): number {
  if (words.length === 0) return 0;
  const heights = words.map((w) => w[3]).sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)] ?? 0;
}

function area([, , w, h]: BBox): number {
  return Math.max(0, w) * Math.max(0, h);
}

function overlap(a: BBox, b: BBox): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

function grow([x, y, w, h]: BBox, dx: number, dy: number): BBox {
  return [x - dx, y - dy, w + 2 * dx, h + 2 * dy];
}

/** Words mostly inside `box` grown by half a word height (the model's usual slip). */
function coveredWords(box: BBox, words: readonly BBox[], slack: number): BBox[] {
  const near = grow(box, slack, slack);
  return words.filter((word) => area(word) > 0 && overlap(word, near) >= COVERED * area(word));
}

/** Words grouped into lines by their vertical centre, top to bottom. */
function lines(words: readonly BBox[], height: number): BBox[][] {
  const sorted = [...words].sort((a, b) => a[1] + a[3] / 2 - (b[1] + b[3] / 2));
  const out: { centre: number; words: BBox[] }[] = [];
  for (const word of sorted) {
    const centre = word[1] + word[3] / 2;
    const line = out.find((l) => Math.abs(l.centre - centre) < height * 0.5);
    if (line) line.words.push(word);
    else out.push({ centre, words: [word] });
  }
  return out.map((l) => l.words);
}

/**
 * A box meant to circle some words: the words it covers, when they're most of what it holds.
 * A box around a figure (few or no words in it) stays as it is.
 */
export function snapRegion(box: BBox, words: readonly BBox[]): BBox {
  const height = wordHeight(words);
  if (height <= 0 || area(box) <= 0) return box;
  const covered = coveredWords(box, words, height * 0.5);
  if (covered.length === 0) return box;
  const snapped = covered.reduce(unionBBox);
  const filled = covered.reduce((sum, w) => sum + overlap(w, box), 0);
  if (filled < TEXT_FILL * area(box)) return box;
  if (overlap(snapped, box) < KEEP * Math.min(area(box), area(snapped))) return box;
  return snapped;
}

/**
 * A box meant to underline or highlight one line of text: the line it overlaps most (the lower
 * one on a tie, where an underline would have gone anyway), across the words it reaches.
 */
export function snapLine(box: BBox, words: readonly BBox[]): BBox {
  const height = wordHeight(words);
  if (height <= 0 || box[2] <= 0) return box;
  const covered = coveredWords(box, words, height * 0.5);
  if (covered.length === 0) return box;
  let best: { line: BBox; share: number } | null = null;
  for (const line of lines(covered, height)) {
    const bounds = line.reduce(unionBBox);
    const top = Math.max(bounds[1], box[1] - height * 0.5);
    const bottom = Math.min(bounds[1] + bounds[3], box[1] + box[3] + height * 0.5);
    const share = Math.max(0, bottom - top) / Math.max(1, bounds[3]);
    if (!best || share >= best.share) best = { line: bounds, share };
  }
  if (!best || best.share < COVERED) return box;
  return best.line;
}

/**
 * An arrow's tip: kept when it's on a word or far from any, else moved to the nearest point of
 * the nearest word (so it touches what it means instead of the gap beside it).
 */
export function snapPoint(
  point: readonly [number, number],
  words: readonly BBox[],
): [number, number] {
  const height = wordHeight(words);
  const [px, py] = point;
  if (height <= 0) return [px, py];
  let best: { at: [number, number]; distance: number } | null = null;
  for (const [x, y, w, h] of words) {
    const at: [number, number] = [
      Math.min(Math.max(px, x), x + w),
      Math.min(Math.max(py, y), y + h),
    ];
    const distance = Math.hypot(at[0] - px, at[1] - py);
    if (distance === 0) return [px, py];
    if (!best || distance < best.distance) best = { at, distance };
  }
  return best && best.distance <= POINT_REACH * height ? best.at : [px, py];
}
