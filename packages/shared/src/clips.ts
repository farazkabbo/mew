import { z } from "zod";

import { HexColor, Point, StrokeTool } from "./notebook";
import { AppName } from "./screen";

/**
 * Clips (Screen Coach S3, docs/SCREEN_COACH_S3.md §3): part of the screen the student chose to
 * save, with the tutor's ink as vectors. Mirrors backend/src/mew_api/clips/models.py.
 *
 * The desktop app creates a clip with its device token after the student pressed Save in the
 * local preview; the web page, signed in, reads it back and builds a notebook page from it
 * (decision 9: notebooks are local-first, so the page itself is built in the browser).
 */
export const CLIP_LIMITS = {
  /** Base64 of the JPEG (~3 MB decoded). */
  imageBase64Chars: 4_000_000,
  /** Longest side of the saved image (brief §3.2). */
  longSide: 2400,
  strokes: 300,
  pointsPerStroke: 2_000,
  points: 30_000,
  titleChars: 200,
  urlChars: 2_000,
  ocrChars: 8_000,
} as const;

/** One stroke of the tutor's ink, in the clip image's pixels ([x, y, pressure, t]). */
export const ClipStroke = z.object({
  tool: StrokeTool,
  color: HexColor,
  width: z.number().positive().max(100),
  points: z.array(Point).min(1).max(CLIP_LIMITS.pointsPerStroke),
});
export type ClipStroke = z.infer<typeof ClipStroke>;

/**
 * A link we're willing to store: https only, and nothing that can hold a secret (decision 9 trims
 * query strings and fragments on the device; this re-checks it).
 */
export const ClipUrl = z
  .url({ protocol: /^https$/, hostname: z.regexes.domain })
  .max(CLIP_LIMITS.urlChars)
  .refine((raw) => {
    const url = parseUrl(raw);
    if (url.username || url.password || url.hash) return false;
    const allowed = isYouTubeHost(url.hostname) ? YOUTUBE_PARAMS : new Set<string>();
    return [...url.searchParams.keys()].every((key) => allowed.has(key));
  }, "links keep only scheme, host and path (and a YouTube video's v and t)");

const YOUTUBE_PARAMS = new Set(["v", "t"]);

/** The parts of a WHATWG URL used here. `URL` exists in every runtime this package runs in
 * (browsers, Node), but this package compiles without DOM or Node types. */
type ParsedUrl = {
  hostname: string;
  username: string;
  password: string;
  hash: string;
  searchParams: { keys(): Iterable<string> };
};

function parseUrl(raw: string): ParsedUrl {
  const { URL } = globalThis as unknown as { URL: new (input: string) => ParsedUrl };
  return new URL(raw);
}

export function isYouTubeHost(hostname: string): boolean {
  return /^(?:www\.|m\.)?youtube\.com$/.test(hostname) || hostname === "youtu.be";
}

const PlainText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((text) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text), {
      message: "control characters aren't allowed",
    });

export const ClipSource = z.object({
  app: AppName,
  /** The window title, kept only because the student saved this clip. */
  title: PlainText(CLIP_LIMITS.titleChars).trim().min(1).optional(),
  url: ClipUrl.optional(),
  timestampSec: z.number().int().min(0).max(86_400).optional(),
  capturedAt: z.iso.datetime(),
});
export type ClipSource = z.infer<typeof ClipSource>;

/** Caps on a Circle & Ask entry (mirrors backend/src/mew_api/clips/models.py). */
export const ENTRY_LIMITS = { steps: 5, markStrokes: 12, turns: 12 } as const;

// ─── Circle & Ask entries (S3.2 §5) ──────────────────────────────────────────────────────────────────────

/** One question and its explanation, as saved in an entry's note. */
export const EntryTurn = z.object({
  question: PlainText(500).min(1),
  steps: z.array(PlainText(220).min(1)).min(1).max(ENTRY_LIMITS.steps),
  summary: PlainText(320).min(1),
  followUpQuestion: PlainText(220).min(1).optional(),
});
export type EntryTurn = z.infer<typeof EntryTurn>;

/**
 * What makes a clip an entry (brief §5): the student's marks and the explanation. The tutor's
 * strokes are the clip's `strokes`; `strokeSteps` says which step each one belongs to (for
 * Replay), counting steps across the entry's turns.
 */
export const EntryPart = z.object({
  sessionId: z.uuid(),
  studentStrokes: z.array(ClipStroke).max(ENTRY_LIMITS.markStrokes),
  turn: EntryTurn,
  /** The step of each tutor stroke in this turn (0-based, within the turn). */
  strokeSteps: z.array(
    z
      .number()
      .int()
      .min(0)
      .max(ENTRY_LIMITS.steps - 1),
  ),
  conceptHints: z.array(PlainText(80).min(1)).max(5),
});
export type EntryPart = z.infer<typeof EntryPart>;

/** An entry as its owner's notebook reads it: every turn so far, and each stroke's step. */
export const EntryView = z.object({
  sessionId: z.uuid(),
  studentStrokes: z.array(ClipStroke),
  turns: z.array(EntryTurn),
  /** For each of the clip's strokes: [turn, step]. */
  strokeSteps: z.array(z.tuple([z.number().int().min(0), z.number().int().min(0)])),
  conceptHints: z.array(z.string()),
});
export type EntryView = z.infer<typeof EntryView>;

/** `POST /api/screen/entries/append`: a follow-up added to its session's entry. */
export const EntryAppendRequest = z
  .object({
    sessionId: z.uuid(),
    turn: EntryTurn,
    strokes: z.array(ClipStroke).max(CLIP_LIMITS.strokes),
    /** The step of each stroke (within this turn). */
    strokeSteps: z.array(
      z
        .number()
        .int()
        .min(0)
        .max(ENTRY_LIMITS.steps - 1),
    ),
    conceptHints: z.array(PlainText(80).trim().min(1)).max(5),
  })
  .refine((a) => a.strokeSteps.length === a.strokes.length, "each stroke has its step");
export type EntryAppendRequest = z.infer<typeof EntryAppendRequest>;

/** `POST /api/screen/clips`, from the desktop app (device token). */
export const ClipCreateRequest = z.object({
  image: z.object({
    jpeg: z.string().min(1).max(CLIP_LIMITS.imageBase64Chars),
    width: z.number().int().min(1).max(CLIP_LIMITS.longSide),
    height: z.number().int().min(1).max(CLIP_LIMITS.longSide),
  }),
  /** Image pixels per CSS pixel of the screen it came from (sizes the image on the page). */
  pixelRatio: z.number().min(0.25).max(8),
  strokes: z.array(ClipStroke).max(CLIP_LIMITS.strokes),
  source: ClipSource,
  /** Text read on the device from the saved (already redacted) image. */
  ocrText: PlainText(CLIP_LIMITS.ocrChars),
  /** Circle & Ask: the explanation that makes this clip a notebook entry. */
  entry: EntryPart.optional(),
});
export type ClipCreateRequest = z.infer<typeof ClipCreateRequest>;

export const ClipCreated = z.object({ clipId: z.uuid() });
export type ClipCreated = z.infer<typeof ClipCreated>;

/** A saved clip as its owner's web page reads it (the image comes from its own route). */
export const ClipView = z.object({
  id: z.uuid(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  pixelRatio: z.number().positive(),
  strokes: z.array(ClipStroke),
  source: ClipSource,
  ocrText: z.string(),
  /** The notebook page built from it (on the device that built it), once there is one. */
  notebookPageId: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  /** A Circle & Ask entry's explanation; null for an ordinary clip. */
  entry: EntryView.nullable().default(null),
});
export type ClipView = z.infer<typeof ClipView>;

export const ClipPatch = z.object({ notebookPageId: z.uuid() });
export type ClipPatch = z.infer<typeof ClipPatch>;

/** Total points across strokes: the server refuses clips over the cap. */
export function clipPointCount(strokes: readonly ClipStroke[]): number {
  return strokes.reduce((n, s) => n + s.points.length, 0);
}
