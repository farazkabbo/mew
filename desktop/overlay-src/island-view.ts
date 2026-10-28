/**
 * What the island shows (`island.rs`'s `IslandView`, sent as `mew:island-show`), checked again
 * here: anything malformed is ignored and the bar keeps its last view.
 */

export type Tool = "none" | "pen" | "eraser" | "select";
export type Shape = "free" | "rect" | "ellipse";
export type Activity = "ready" | "listening" | "looking" | "thinking" | "speaking" | "paused";

export type IslandView = {
  tool: Tool;
  shape: Shape;
  mic: boolean;
  silent: boolean;
  activity: Activity;
  clearable: boolean;
};

const TOOLS: readonly Tool[] = ["none", "pen", "eraser", "select"];
const SHAPES: readonly Shape[] = ["free", "rect", "ellipse"];
const ACTIVITIES: readonly Activity[] = [
  "ready",
  "listening",
  "looking",
  "thinking",
  "speaking",
  "paused",
];

function oneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

export function parseIslandView(detail: unknown): IslandView | null {
  if (typeof detail !== "object" || detail === null) return null;
  const { tool, shape, mic, silent, activity, clearable } = detail as Record<string, unknown>;
  if (!oneOf(tool, TOOLS) || !oneOf(shape, SHAPES) || !oneOf(activity, ACTIVITIES)) return null;
  if (typeof mic !== "boolean" || typeof silent !== "boolean" || typeof clearable !== "boolean") {
    return null;
  }
  return { tool, shape, mic, silent, activity, clearable };
}

/** What's playing (`music.rs`'s `NowPlaying`), as the music panel shows it. */
export type NowPlaying = {
  title: string;
  artist: string;
  player: string | null;
  playing: boolean;
  canPrevious: boolean;
  canNext: boolean;
  /** A `data:` URL of a PNG or JPEG. */
  art: string | null;
};

export type PinKind = "playlist" | "album";
export type PinView = { kind: PinKind; id: string; name: string };

/** The music panel (`music.rs`'s `MusicView`, sent as `mew:island-music`). */
export type MusicView = {
  now: NowPlaying | null;
  pins: PinView[];
  notice: string | null;
  pinning: boolean;
};

export type Control = "play_pause" | "next" | "previous";

const PIN_KINDS: readonly PinKind[] = ["playlist", "album"];
const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/;
/** Only album art Rust checked: a PNG or JPEG as base64. */
const ART_URL = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
/** Rust cuts text to 120 characters; in UTF-16 units that can be up to twice as many. */
const MAX_TEXT = 300;
const MAX_PINS = 6;

function text(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT;
}

function parseNowPlaying(value: unknown): NowPlaying | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const { title, artist, player, playing, can_previous, can_next, art } = value as Record<
    string,
    unknown
  >;
  if (!text(title) || !text(artist) || (player !== null && !text(player))) return undefined;
  if (
    typeof playing !== "boolean" ||
    typeof can_previous !== "boolean" ||
    typeof can_next !== "boolean"
  ) {
    return undefined;
  }
  if (art !== null && (typeof art !== "string" || !ART_URL.test(art))) return undefined;
  return { title, artist, player, playing, canPrevious: can_previous, canNext: can_next, art };
}

function parsePin(value: unknown): PinView | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, id, name } = value as Record<string, unknown>;
  if (!oneOf(kind, PIN_KINDS) || typeof id !== "string" || !SPOTIFY_ID.test(id) || !text(name)) {
    return null;
  }
  return { kind, id, name };
}

export function parseMusicView(detail: unknown): MusicView | null {
  if (typeof detail !== "object" || detail === null) return null;
  const { now, pins, notice, pinning } = detail as Record<string, unknown>;
  const playing = parseNowPlaying(now);
  if (playing === undefined || !Array.isArray(pins) || pins.length > MAX_PINS) return null;
  const parsed = pins.map(parsePin);
  if (parsed.some((pin) => pin === null)) return null;
  if ((notice !== null && !text(notice)) || typeof pinning !== "boolean") return null;
  return { now: playing, pins: parsed as PinView[], notice, pinning };
}

export const PIN_KIND_LABEL: Record<PinKind, string> = {
  playlist: "Playlist",
  album: "Album",
};

/** The words beside the status dot. */
export const ACTIVITY_LABEL: Record<Activity, string> = {
  ready: "Neb",
  listening: "Listening…",
  looking: "Looking…",
  thinking: "Thinking…",
  speaking: "Speaking",
  paused: "Paused",
};

export const SHAPE_LABEL: Record<Shape, string> = {
  free: "Freehand",
  rect: "Rectangle",
  ellipse: "Ellipse",
};

/**
 * The ears where the island meets the top edge (none: Windows shows a pale band along the top
 * of the window wherever the page leaves it clear, so the top stays solid and square), and its
 * bottom corners (CSS pixels).
 */
export const EAR = 0;
export const RADIUS = { closed: 22, open: 28 } as const;
/** The island's height closed (CSS px); open, it's as tall as what it shows. */
export const CLOSED_HEIGHT = 58;
/** How long the pointer rests on a button before its name shows (ms). */
export const TIP_DELAY_MS = 600;

/**
 * The island's outline filling a `w` × `h` window, as an SVG path: like a Mac's notch, flat
 * along the top edge of the screen with an ear curving in at each end, straight sides, and round
 * bottom corners. Drawn smooth (the window is transparent around it).
 */
export function notchPath(w: number, h: number, ear: number, radius: number): string {
  const e = Math.max(0, Math.min(ear, w / 4, h / 2));
  const r = Math.max(0, Math.min(radius, (w - 2 * e) / 2, h - e));
  const n = (v: number) => Math.round(v * 100) / 100;
  return [
    `M0 0H${n(w)}`,
    `A${n(e)} ${n(e)} 0 0 0 ${n(w - e)} ${n(e)}`,
    `V${n(h - r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(w - e - r)} ${n(h)}`,
    `H${n(e + r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(e)} ${n(h - r)}`,
    `V${n(e)}`,
    `A${n(e)} ${n(e)} 0 0 0 0 0Z`,
  ].join("");
}
