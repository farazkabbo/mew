import type { StrokeTool } from "@mew/shared";

/**
 * Ink colours. Strokes store the light-theme hex; dark mode remaps known colours so ink stays
 * readable on a dark page. Unknown colours render as stored.
 */
export const INK_COLORS = [
  { name: "Ink", light: "#26292e", dark: "#e2ded4" },
  { name: "Blue", light: "#3e6db5", dark: "#7fa6e8" },
  { name: "Red", light: "#c2453a", dark: "#e07b70" },
  { name: "Green", light: "#2f7d55", dark: "#72c99b" },
] as const;

export const HIGHLIGHTER_COLORS = [
  { name: "Yellow", light: "#f5cf2f66", dark: "#f5cf2f55" },
  { name: "Mint", light: "#5fd3a466", dark: "#5fd3a455" },
  { name: "Pink", light: "#f58fb866", dark: "#f58fb855" },
] as const;

/** neb's violet (NEB_APP_UI §3.1, decision U2): `--neb` light and night. */
export const TUTOR_INK = { light: "#6b4ee6", dark: "#9c86ff" } as const;
/** The tutor's highlighter (Screen Coach clips: desktop/src-tauri/src/screen/ink.rs). */
export const TUTOR_HIGHLIGHT = { light: "#6b4ee655", dark: "#9c86ff44" } as const;

/**
 * Colours strokes were saved in before the U series (the tutor's old violet, the old pens): they
 * render as today's. Strokes keep the colour they were stored with.
 */
const LEGACY = new Map<string, string>([
  ["#8a7bf0", TUTOR_INK.light],
  ["#8a7bf055", TUTOR_HIGHLIGHT.light],
  ["#1d1c1a", INK_COLORS[0].light],
  ["#2f5fd0", INK_COLORS[1].light],
  ["#c8432b", INK_COLORS[2].light],
]);

const DARK_VARIANTS = new Map<string, string>(
  [...INK_COLORS, ...HIGHLIGHTER_COLORS, TUTOR_INK, TUTOR_HIGHLIGHT].map((c) => [
    c.light.toLowerCase(),
    c.dark,
  ]),
);

export function displayColor(hex: string, dark: boolean): string {
  const current = LEGACY.get(hex.toLowerCase()) ?? hex;
  return dark ? (DARK_VARIANTS.get(current.toLowerCase()) ?? current) : current;
}

export type Tool = StrokeTool | "eraser" | "lasso";

/** Pen sizes in page units. */
export const PEN_WIDTHS = { S: 2, M: 3.5, L: 6 } as const;
export type PenSize = keyof typeof PEN_WIDTHS;

export const HIGHLIGHTER_WIDTH = 18;
/** Eraser radius in screen pixels (converted to page units at the current zoom). */
export const ERASER_RADIUS_PX = 10;
