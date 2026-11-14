/**
 * The design tokens (docs/NEB_APP_UI.md §3): the one source for the web app's CSS variables, the
 * desktop overlays' generated `desktop/shell/tokens.css`, the contrast tests and the Rust
 * indicator's colour. Plain data: no CSS-in-JS.
 */

export type ColorName =
  | "desk"
  | "paper"
  | "paper-hi"
  | "ink"
  | "pencil"
  | "muted"
  | "line"
  | "rule"
  | "margin-red"
  | "neb"
  | "neb-ink"
  | "neb-wash"
  | "note"
  | "sunk"
  | "teal"
  | "ok-pen"
  | "red-pen"
  | "danger";

/** §3.1: light, and night desk. */
export const COLORS: Record<"light" | "night", Record<ColorName, string>> = {
  light: {
    desk: "#ECE6D8",
    paper: "#FBF8F0",
    "paper-hi": "#FFFEFB",
    ink: "#1E1D1A",
    pencil: "#26292E",
    muted: "#5F5A50",
    line: "#D3CAB7",
    rule: "#D6E2E6",
    "margin-red": "#E9B9B2",
    neb: "#6B4EE6",
    "neb-ink": "#3F2BA0",
    "neb-wash": "#F1EDFF",
    note: "#F1E5AE",
    /** U28: inactive divider tabs and icon tiles, a shade under the desk. */
    sunk: "#E2DACA",
    teal: "#7DA4AF",
    "ok-pen": "#3E6DB5",
    "red-pen": "#C2453A",
    danger: "#A8402F",
  },
  night: {
    desk: "#1B1F23",
    paper: "#22272C",
    "paper-hi": "#2A3036",
    ink: "#ECE6D8",
    pencil: "#E2DED4",
    muted: "#A9A294",
    line: "#3A4047",
    rule: "#2F3A40",
    "margin-red": "#6A3E3A",
    neb: "#9C86FF",
    "neb-ink": "#C9BCFF",
    "neb-wash": "#2C2550",
    note: "#5A5230",
    sunk: "#2E3439",
    teal: "#7DA4AF",
    "ok-pen": "#7FA6E8",
    "red-pen": "#E07B70",
    danger: "#E8907F",
  },
};

/** Notebook cover colours (§3.1): student-picked, never violet. */
export const COVER_COLORS = [
  { name: "teal", hex: "#7DA4AF" },
  { name: "clay", hex: "#C98B6B" },
  { name: "ink", hex: "#3A3833" },
  { name: "sage", hex: "#8FA98B" },
  { name: "mustard", hex: "#D4B45A" },
  { name: "sky", hex: "#9DB8D9" },
  { name: "rose", hex: "#C99AA4" },
  { name: "slate", hex: "#6F7C86" },
] as const;

/** §3.3. */
export const SHADOWS = {
  "sh-1": "0 1px 0 var(--line)",
  "sh-2": "0 10px 24px -14px #1E1D1A66",
  "sh-3": "0 24px 50px -30px #1E1D1A99",
} as const;

/** §3.3: layers, bottom to top. The screen coach overlays are separate topmost windows. */
export const LAYERS = {
  "z-page": 0,
  "z-ink": 10,
  "z-marks": 20,
  "z-notes": 30,
  "z-tools": 40,
  "z-toasts": 50,
  "z-pickers": 60,
} as const;

/** §3.4. */
export const MOTION = {
  "t-quick": "120ms ease-out",
  "t-move": "220ms cubic-bezier(.2, .8, .2, 1)",
} as const;

/** §3.2: the families, by CSS variable (set by next/font in the app, @font-face in overlays). */
export const FONT_STACKS = {
  "font-ui": 'var(--font-inter), "Inter", ui-sans-serif, system-ui, sans-serif',
  "font-display": 'var(--font-instrument-serif), "Instrument Serif", ui-serif, Georgia, serif',
  "font-neb": 'var(--font-pixelify), "Pixelify Sans", ui-monospace, monospace',
  "font-hand": 'var(--font-caveat), "Caveat", cursive',
} as const;

/** Text-size setting (§3.10): the UI scales, the ink doesn't. */
export const TEXT_SCALE = { min: 0.9, max: 1.3, step: 0.05, default: 1 } as const;

/**
 * The CSS for every token: light on :root, night when the OS asks for dark (unless the student
 * chose light) or when they chose night (§3.1: `data-theme` on <html>).
 */
export function tokensCss(): string {
  const vars = (record: Record<string, string | number>, indent: string) =>
    Object.entries(record)
      .map(([name, value]) => `${indent}--${name}: ${value};`)
      .join("\n");
  const shared = { ...SHADOWS, ...LAYERS, ...MOTION, ...FONT_STACKS };
  return [
    "/* Generated from packages/shared/src/ui/tokens.ts by `pnpm build:tokens`. Don't edit. */",
    "",
    ":root {",
    vars(COLORS.light, "  "),
    vars(shared, "  "),
    "  color-scheme: light;",
    "}",
    "",
    "@media (prefers-color-scheme: dark) {",
    '  :root:not([data-theme="light"]) {',
    vars(COLORS.night, "    "),
    "    color-scheme: dark;",
    "  }",
    "}",
    "",
    ':root[data-theme="night"] {',
    vars(COLORS.night, "  "),
    "  color-scheme: dark;",
    "}",
    "",
  ].join("\n");
}

// ─── Contrast (§3.10) ─────────────────────────────────────────────────────────────────────────

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** WCAG contrast ratio of two #RRGGBB colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text colours and the backgrounds they're used on: each pair must reach 4.5:1. */
export const TEXT_PAIRS: readonly (readonly [ColorName, ColorName])[] = [
  ["ink", "desk"],
  ["ink", "paper"],
  ["ink", "paper-hi"],
  ["muted", "desk"],
  ["muted", "paper"],
  ["muted", "paper-hi"],
  ["neb-ink", "paper"],
  ["neb-ink", "paper-hi"],
  ["neb-ink", "neb-wash"],
  ["neb-ink", "desk"],
  ["paper", "ink"],
  ["danger", "paper"],
  ["danger", "paper-hi"],
  ["pencil", "paper"],
];
