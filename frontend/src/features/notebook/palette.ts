import type { StrokeTool } from "@mew/shared";

/**
 * Ink colours. Strokes store the light-theme hex; dark mode remaps known colours so ink stays
 * readable on a dark page. Unknown colours render as stored.
 */
export const INK_COLORS = [
  { name: "Ink", light: "#1d1c1a", dark: "#ece9e2" },
  { name: "Blue", light: "#2f5fd0", dark: "#86a8f7" },
  { name: "Red", light: "#c8432b", dark: "#f28a70" },
  { name: "Green", light: "#2f7d55", dark: "#72c99b" },
] as const;

export const HIGHLIGHTER_COLORS = [
  { name: "Yellow", light: "#f5cf2f66", dark: "#f5cf2f55" },
  { name: "Mint", light: "#5fd3a466", dark: "#5fd3a455" },
  { name: "Pink", light: "#f58fb866", dark: "#f58fb855" },
] as const;

export const TUTOR_INK = { light: "#8a7bf0", dark: "#a497ff" } as const;

const DARK_VARIANTS = new Map<string, string>(
  [...INK_COLORS, ...HIGHLIGHTER_COLORS, TUTOR_INK].map((c) => [c.light.toLowerCase(), c.dark]),
);

export function displayColor(hex: string, dark: boolean): string {
  return dark ? (DARK_VARIANTS.get(hex.toLowerCase()) ?? hex) : hex;
}

export type Tool = StrokeTool | "eraser" | "lasso";

/** Pen sizes in page units. */
export const PEN_WIDTHS = { S: 2, M: 3.5, L: 6 } as const;
export type PenSize = keyof typeof PEN_WIDTHS;

export const HIGHLIGHTER_WIDTH = 18;
/** Eraser radius in screen pixels (converted to page units at the current zoom). */
export const ERASER_RADIUS_PX = 10;
