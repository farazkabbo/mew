import data from "./hershey.json";

/**
 * Single-stroke glyphs (Hershey, see NOTICE.md) in **x-height units**: the x-height is 1, the
 * origin is the glyph's left edge on the baseline, and y grows downwards (ascent is negative y).
 */
export type Glyph = {
  advance: number;
  /** Polylines as flat [x0, y0, x1, y1, …] lists. */
  strokes: readonly (readonly number[])[];
};

type RawGlyph = [left: number, right: number, strokes: number[][]];
type RawFont = {
  units: { baseline: number; xTop: number; capTop: number };
  glyphs: Record<string, RawGlyph>;
};

const raw = data as unknown as RawFont;
const UNIT = raw.units.baseline - raw.units.xTop; // Hershey units per x-height (14)

/** Vertical metrics in x-height units (heights above the baseline). */
export const FONT_METRICS = {
  capHeight: (raw.units.baseline - raw.units.capTop) / UNIT,
  descent: 0.5,
  /** Height of the maths axis (centre of + − =), where fraction bars sit. */
  axis: raw.units.baseline / UNIT,
} as const;

/** Characters drawn with another character's glyph. */
const ALIASES: Record<string, string> = {
  "−": "-",
  "–": "-",
  "—": "-",
  "‐": "-",
  "⋅": "·",
  "∙": "·",
  "′": "'",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  ϑ: "θ",
  ϕ: "φ",
  ϵ: "ε",
  "⟶": "→",
  "⟵": "←",
  "⟹": "⇒",
  "⇋": "⇌",
};

const cache = new Map<string, Glyph | null>();
let overrides: ReadonlyMap<string, Glyph> | null = null;

/**
 * Runs `draw` with some characters drawn differently (the handwriting eval's writers: a 7 that
 * looks like a 1). Synchronous, so nothing else ever sees the overrides.
 */
export function withGlyphOverrides<T>(replacements: ReadonlyMap<string, Glyph>, draw: () => T): T {
  const before = overrides;
  overrides = replacements;
  try {
    return draw();
  } finally {
    overrides = before;
  }
}

/** The glyph for one character, or undefined when the font can't draw it. */
export function glyph(ch: string): Glyph | undefined {
  const key = ch === " " ? " " : (ALIASES[ch] ?? ch);
  const replaced = overrides?.get(key);
  if (replaced) return replaced;
  let found = cache.get(key);
  if (found === undefined) {
    const source = raw.glyphs[key];
    found = source ? convert(source) : null;
    cache.set(key, found);
  }
  return found ?? undefined;
}

export function hasGlyph(ch: string): boolean {
  return glyph(ch) !== undefined;
}

function convert([left, right, strokes]: RawGlyph): Glyph {
  return {
    advance: (right - left) / UNIT,
    strokes: strokes.map((flat) =>
      flat.map((v, i) => (i % 2 === 0 ? (v - left) / UNIT : (v - raw.units.baseline) / UNIT)),
    ),
  };
}
