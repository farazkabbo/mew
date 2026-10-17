import type { BBox, Stroke } from "@mew/shared";

import { horizontalGap, intervalOverlap, median, unionBBox } from "./geometry";

export type SegmentableStroke = Pick<Stroke, "id" | "bbox" | "createdAt">;

export type Line = {
  /** Stable while the line's first stroke exists: `line_<id of its earliest stroke>`. */
  id: string;
  strokeIds: string[];
  bbox: BBox;
  firstCreatedAt: number;
  lastCreatedAt: number;
};

export type SegmentationOptions = {
  /** Floor for the reference letter height, in page units. */
  minLetterHeight: number;
  /** Vertical overlap (fraction of the smaller band) needed to join a line. */
  overlapThreshold: number;
  /** Relaxed threshold for a stroke written right after the line's latest stroke. */
  recentOverlapThreshold: number;
  /** "Right after", in ms. */
  recentMs: number;
  /** Max horizontal gap to a line, in multiples of the letter height. */
  maxGapInLetters: number;
  /** Strokes taller than this many letter heights (∫, brackets) don't shape a line's band. */
  tallStrokeInLetters: number;
};

const DEFAULTS: SegmentationOptions = {
  minLetterHeight: 6,
  overlapThreshold: 0.4,
  recentOverlapThreshold: 0.15,
  recentMs: 1500,
  maxGapInLetters: 8,
  tallStrokeInLetters: 2.2,
};

type Cluster = {
  strokes: SegmentableStroke[];
  bbox: BBox;
  /** Vertical extent of the line's regular-height strokes. */
  band: [top: number, bottom: number];
  lastCreatedAt: number;
};

/**
 * Clusters handwriting into lines by vertical overlap and writing order, so "the current line"
 * can be cropped and sent for recognition. Strokes are visited in the order they were written;
 * each joins the best-overlapping nearby line or starts a new one.
 */
export function segmentLines(
  strokes: readonly SegmentableStroke[],
  options: Partial<SegmentationOptions> = {},
): Line[] {
  if (strokes.length === 0) return [];
  const opts = { ...DEFAULTS, ...options };
  const letter = Math.max(opts.minLetterHeight, median(strokes.map((s) => s.bbox[3])));
  const isTall = (s: SegmentableStroke) => s.bbox[3] > opts.tallStrokeInLetters * letter;

  const clusters: Cluster[] = [];
  const ordered = [...strokes].sort((a, b) => a.createdAt - b.createdAt || cmp(a.id, b.id));

  for (const stroke of ordered) {
    const band = strokeBand(stroke, letter, isTall(stroke));
    let best: Cluster | undefined;
    let bestScore = 0;
    for (const cluster of clusters) {
      if (horizontalGap(stroke.bbox, cluster.bbox) > opts.maxGapInLetters * letter) continue;
      const recent = stroke.createdAt - cluster.lastCreatedAt <= opts.recentMs;
      const threshold = recent ? opts.recentOverlapThreshold : opts.overlapThreshold;
      const score = overlapRatio(band, cluster.band);
      if (score >= threshold && score > bestScore) {
        best = cluster;
        bestScore = score;
      }
    }

    if (best) {
      best.strokes.push(stroke);
      best.bbox = unionBBox(best.bbox, stroke.bbox);
      best.lastCreatedAt = Math.max(best.lastCreatedAt, stroke.createdAt);
      if (!isTall(stroke)) {
        best.band = [Math.min(best.band[0], band[0]), Math.max(best.band[1], band[1])];
      }
    } else {
      clusters.push({
        strokes: [stroke],
        bbox: stroke.bbox,
        band,
        lastCreatedAt: stroke.createdAt,
      });
    }
  }

  return mergeStackedFractions(clusters, letter)
    .map(toLine)
    .sort(
      (a, b) => a.bbox[1] + a.bbox[3] / 2 - (b.bbox[1] + b.bbox[3] / 2) || a.bbox[0] - b.bbox[0],
    );
}

/** The line the student wrote in most recently, if any. */
export function currentLine(lines: readonly Line[]): Line | undefined {
  let latest: Line | undefined;
  for (const line of lines) {
    if (!latest || line.lastCreatedAt > latest.lastCreatedAt) latest = line;
  }
  return latest;
}

/**
 * Vertical band a stroke occupies for matching. Tall strokes are reduced to a letter-height band
 * around their centre, so an integral sign doesn't swallow the lines above and below it.
 */
function strokeBand(stroke: SegmentableStroke, letter: number, tall: boolean): [number, number] {
  const [, y, , h] = stroke.bbox;
  if (tall) {
    const centre = y + h / 2;
    return [centre - letter / 2, centre + letter / 2];
  }
  // Very flat strokes (minus signs, fraction bars) get half a letter of height to match against.
  const pad = Math.max(0, letter / 2 - h) / 2;
  return [y - pad, y + h + pad];
}

/**
 * Stacked fractions span three bands (numerator, bar, denominator), so the first pass can split
 * them. A flat, wide stroke acts as a fraction bar: lines sitting directly above or below it,
 * within its horizontal extent, are merged into the bar's line.
 */
function mergeStackedFractions(clusters: Cluster[], letter: number): Cluster[] {
  const result = [...clusters];
  let changed = true;
  while (changed) {
    changed = false;
    for (const host of result) {
      const bars = host.strokes.filter((s) => isFractionBar(s.bbox, letter));
      const stacked = result.find(
        (other) => other !== host && bars.some((bar) => stacksOn(other.bbox, bar.bbox, letter)),
      );
      if (!stacked) continue;
      host.strokes.push(...stacked.strokes);
      host.bbox = unionBBox(host.bbox, stacked.bbox);
      host.lastCreatedAt = Math.max(host.lastCreatedAt, stacked.lastCreatedAt);
      result.splice(result.indexOf(stacked), 1);
      changed = true;
      break;
    }
  }
  return result;
}

function isFractionBar([, , w, h]: BBox, letter: number): boolean {
  return h <= 0.35 * letter && w >= 1.2 * letter;
}

/** Whether `box` sits just above or below `bar`, within the bar's width (with a little slack). */
function stacksOn(box: BBox, bar: BBox, letter: number): boolean {
  const slack = 0.5 * letter;
  const within = box[0] >= bar[0] - slack && box[0] + box[2] <= bar[0] + bar[2] + slack;
  if (!within) return false;
  const gapAbove = bar[1] - (box[1] + box[3]);
  const gapBelow = box[1] - (bar[1] + bar[3]);
  const near = (gap: number) => gap >= -0.3 * letter && gap <= 0.8 * letter;
  return near(gapAbove) || near(gapBelow);
}

function overlapRatio(a: [number, number], b: [number, number]): number {
  const smaller = Math.max(1e-6, Math.min(a[1] - a[0], b[1] - b[0]));
  return intervalOverlap(a[0], a[1], b[0], b[1]) / smaller;
}

function toLine(cluster: Cluster): Line {
  const strokes = [...cluster.strokes].sort((a, b) => a.createdAt - b.createdAt || cmp(a.id, b.id));
  const first = strokes[0];
  return {
    id: `line_${first?.id ?? "empty"}`,
    strokeIds: strokes.map((s) => s.id),
    bbox: cluster.bbox,
    firstCreatedAt: first?.createdAt ?? 0,
    lastCreatedAt: cluster.lastCreatedAt,
  };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
