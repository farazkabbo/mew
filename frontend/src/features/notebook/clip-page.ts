import type { ClipView, ImageBlock, Point, Stroke } from "@mew/shared";
import { strokeBBox } from "@mew/ink";

/**
 * A clip saved from the screen (Screen Coach S3), laid out as a notebook page: the image at the
 * top, at the size it had on screen (never wider than the page column), and the tutor's
 * annotations over it as ordinary tutor ink — editable, erasable and hideable like any other.
 * The rest of the page stays free to work on.
 */

/** Widest an image is placed, in page units (CSS pixels at 100 % zoom). */
export const MAX_IMAGE_WIDTH = 720;
/** Top-left corner of the image: clear of the floating toolbar at the default view. */
export const IMAGE_ORIGIN: readonly [number, number] = [48, 104];

export type ClipPage = { image: ImageBlock; strokes: Stroke[] };

export function clipToPage(
  clip: ClipView,
  pageId: string,
  { now, newId }: { now: number; newId: () => string },
): ClipPage {
  const screenWidth = clip.width / clip.pixelRatio;
  const width = Math.min(screenWidth, MAX_IMAGE_WIDTH);
  const scale = width / clip.width;
  const height = clip.height * scale;
  const [x, y] = IMAGE_ORIGIN;

  const groupId = newId();
  const strokes: Stroke[] = clip.strokes.map((stroke, i) => {
    const points = stroke.points.map(
      ([px, py, pressure, t]) => [x + px * scale, y + py * scale, pressure, t] as Point,
    );
    const strokeWidth = Math.min(100, Math.max(0.1, stroke.width * scale));
    return {
      id: newId(),
      pageId,
      author: "tutor",
      tool: stroke.tool,
      points,
      color: stroke.color,
      width: strokeWidth,
      bbox: strokeBBox(points, strokeWidth),
      createdAt: now + i,
      groupId,
    };
  });

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

function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
