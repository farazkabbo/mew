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
/** The island's height closed (CSS px); open, it fills its window. */
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
