import type { ClipStroke, ClipView, ImageBlock, ImageEntry, Point, Stroke } from "@mew/shared";
import { strokeBBox } from "@mew/ink";

/**
 * A clip saved from the screen (Screen Coach S3), laid out as a notebook page: the image at the
 * top, at the size it had on screen (never wider than the page column), and the tutor's
 * annotations over it as ordinary tutor ink — editable, erasable and hideable like any other.
 * The rest of the page stays free to work on.
 *
 * A Circle & Ask entry (S3.2 §5) is laid out the same way, one below the other on the day's
 * "From screen" page, with the student's marks as their own ink, the tutor's ink in one group
 * per explanation step (for Replay), and the explanation shown under the picture.
 */

/** Widest an image is placed, in page units (CSS pixels at 100 % zoom). */
export const MAX_IMAGE_WIDTH = 720;
/** Top-left corner of the image: clear of the floating toolbar at the default view. */
export const IMAGE_ORIGIN: readonly [number, number] = [48, 104];

export type ClipPage = { image: ImageBlock; strokes: Stroke[] };

type Ids = { now: number; newId: () => string };

/** Where a clip's image goes on the page: its corner, and page units per image pixel. */
type Placement = { x: number; y: number; scale: number };

function placement(clip: ClipView, [x, y]: readonly [number, number]) {
  const screenWidth = clip.width / clip.pixelRatio;
  const width = Math.min(screenWidth, MAX_IMAGE_WIDTH);
  const scale = width / clip.width;
  return { x, y, scale, width, height: clip.height * scale };
}

/** A clip stroke (image pixels) as a page stroke. */
function placed(
  stroke: ClipStroke,
  { x, y, scale }: Placement,
  page: { pageId: string; author: Stroke["author"]; groupId?: string; createdAt: number },
  newId: () => string,
): Stroke {
  const points = stroke.points.map(
    ([px, py, pressure, t]) => [x + px * scale, y + py * scale, pressure, t] as Point,
  );
  const width = Math.min(100, Math.max(0.1, stroke.width * scale));
  return {
    id: newId(),
    pageId: page.pageId,
    author: page.author,
    tool: stroke.tool,
    points,
    color: stroke.color,
    width,
    bbox: strokeBBox(points, width),
    createdAt: page.createdAt,
    ...(page.groupId && { groupId: page.groupId }),
  };
}

export function clipToPage(clip: ClipView, pageId: string, ids: Ids): ClipPage {
  return laidOut(clip, pageId, IMAGE_ORIGIN, ids);
}

function laidOut(
  clip: ClipView,
  pageId: string,
  origin: readonly [number, number],
  { now, newId }: Ids,
): ClipPage {
  const place = placement(clip, origin);
  const { x, y, width, height } = place;
  const groupId = newId();
  const strokes: Stroke[] = clip.strokes.map((stroke, i) =>
    placed(stroke, place, { pageId, author: "tutor", groupId, createdAt: now + i }, newId),
  );

  const { source } = clip;
  const image: ImageBlock = {
    id: newId(),
    pageId,
    type: "image",
    clipId: clip.id,
    x,
    y,
    width,
    height,
    source: {
      app: source.app,
      capturedAt: source.capturedAt,
      ...(source.title !== undefined && { title: source.title }),
      ...(source.url !== undefined && { url: source.url }),
      ...(source.timestampSec !== undefined && { timestampSec: source.timestampSec }),
    },
    ...(clip.ocrText && { ocrText: clip.ocrText }),
    createdAt: now,
  };
  return { image, strokes };
}

/** A link we're willing to render: https only (it was checked when saved; checked again). */
export function safeLink(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

/** "Lecture 5 · 12:34" or the app's name: the source line under a clip. */
export function sourceLabel(image: ImageBlock): string {
  const source = image.source;
  if (!source) return "Saved from your screen";
  const name = source.title ?? source.app.replace(/\.exe$/, "");
  const at = source.timestampSec === undefined ? "" : ` · ${clock(source.timestampSec)}`;
  return `${name}${at}`;
}

/** "12:34" or "1:02:03". */
export function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// ─── Circle & Ask entries ────────────────────────────────────────────────────────────────────

/** Room left under an entry's note to write (§2.5), in page units. */
export const ENTRY_GAP = 160;
/** The note's lines, as the notebook shows them (an estimate: the note is HTML). */
const NOTE_LINE = 22;
const NOTE_PADDING = 24;
const CHARS_PER_LINE_PER_UNIT = 1 / 7.5;

/** About how tall an entry's note is under its picture, in page units. */
export function noteHeight(entry: ImageEntry, width: number): number {
  const perLine = Math.max(20, Math.floor(width * CHARS_PER_LINE_PER_UNIT));
  const lines = entry.turns
    .flatMap((t) => [t.question, ...t.steps.map((s, i) => `${i + 1}. ${s}`), t.summary])
    .reduce((n, text) => n + Math.max(1, Math.ceil(text.length / perLine)), 0);
  return NOTE_PADDING + lines * NOTE_LINE;
}

/** Where the next entry goes on a "From screen" page: under the last one, with room to write. */
export function nextEntryTop(images: readonly ImageBlock[]): number {
  return images.reduce((top, image) => {
    const bottom =
      image.y + image.height + (image.entry ? noteHeight(image.entry, image.width) : 0);
    return Math.max(top, bottom + ENTRY_GAP);
  }, IMAGE_ORIGIN[1]);
}

/**
 * An entry laid out at `top`: the picture, the student's marks (their own strokes), and the
 * tutor's ink in a group per explanation step.
 */
export function entryToPage(clip: ClipView, pageId: string, top: number, ids: Ids): ClipPage {
  const page = laidOut(clip, pageId, [IMAGE_ORIGIN[0], top], ids);
  const entry = clip.entry;
  if (!entry) return page;
  const place = placement(clip, [IMAGE_ORIGIN[0], top]);
  const stepGroups = entry.turns.map((turn) => turn.steps.map(() => ids.newId()));
  const tutor = page.strokes.map((stroke, i) => {
    const [turn, step] = entry.strokeSteps[i] ?? [0, 0];
    const groupId = stepGroups[turn]?.[step];
    return groupId ? { ...stroke, groupId } : stroke;
  });
  const student = entry.studentStrokes.map((stroke, i) =>
    placed(
      stroke,
      place,
      { pageId, author: "student", createdAt: ids.now + tutor.length + i },
      ids.newId,
    ),
  );
  const image: ImageBlock = {
    ...page.image,
    entry: {
      sessionId: entry.sessionId,
      turns: entry.turns,
      stepGroups,
      strokeCount: clip.strokes.length,
    },
  };
  return { image, strokes: [...student, ...tutor] };
}

/**
 * A follow-up added to an entry already on the page: the new turns' tutor strokes (in their
 * step groups), and the image block's entry brought up to date.
 */
export function entryFollowUps(
  clip: ClipView,
  image: ImageBlock,
  ids: Ids,
): { strokes: Stroke[]; image: ImageBlock } | null {
  const entry = clip.entry;
  const known = image.entry;
  if (!entry || !known || entry.turns.length <= known.turns.length) return null;
  const stepGroups = [
    ...known.stepGroups,
    ...entry.turns.slice(known.turns.length).map((turn) => turn.steps.map(() => ids.newId())),
  ];
  const place = { x: image.x, y: image.y, scale: image.width / clip.width };
  const strokes = clip.strokes.slice(known.strokeCount).map((stroke, i) => {
    const [turn, step] = entry.strokeSteps[known.strokeCount + i] ?? [0, 0];
    const groupId = stepGroups[turn]?.[step];
    return placed(
      stroke,
      place,
      {
        pageId: image.pageId,
        author: "tutor",
        createdAt: ids.now + i,
        ...(groupId && { groupId }),
      },
      ids.newId,
    );
  });
  return {
    strokes,
    image: {
      ...image,
      entry: { ...known, turns: entry.turns, stepGroups, strokeCount: clip.strokes.length },
    },
  };
}

/** Today, as the "From screen" page is named by (the student's own calendar day). */
export function today(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
