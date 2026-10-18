/**
 * Builds the tutor's single-stroke glyph table (packages/ink/src/tutor/glyphs/hershey.json) from
 * Hershey font files in the James Hurt `.jhf` format.
 *
 *   pnpm tsx scripts/build-glyphs.ts <dir containing futural.jhf, greeks.jhf, mathupp.jhf>
 *
 * Source: https://github.com/kamalmostafa/hershey-fonts at commit SOURCE_COMMIT (the
 * `hershey-fonts/` folder). Only the font data is used, not that repository's GPL code. The
 * Hershey licence asks that its acknowledgements ship with the data: see glyphs/NOTICE.md.
 * Converting to this JSON format is permitted (anything but the NTIS format).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SOURCE_COMMIT = "1356bf2f83d380fcef68c887e88675eb9d445d86";
const OUT = path.resolve(import.meta.dirname, "../packages/ink/src/tutor/glyphs/hershey.json");

/** [left, right, strokes]: each stroke a flat [x0, y0, x1, y1, …] list in Hershey units. */
type Glyph = [left: number, right: number, strokes: number[][]];

const R = "R".charCodeAt(0);

/** Parses a .jhf file into glyphs in file order (slot i holds ASCII 32 + i). */
function parseJhf(file: string): Glyph[] {
  const lines = readFileSync(file, "latin1").split(/\r?\n/);
  const glyphs: Glyph[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++] ?? "";
    if (!line.trim()) continue;
    const count = Number(line.slice(5, 8));
    let data = line.slice(8);
    // Long glyphs wrap onto continuation lines.
    while (data.length < count * 2 && i < lines.length) data += lines[i++] ?? "";
    const strokes: number[][] = [];
    let current: number[] = [];
    for (let k = 2; k < count * 2; k += 2) {
      if (data[k] === " " && data[k + 1] === "R") {
        if (current.length) strokes.push(current);
        current = [];
        continue;
      }
      current.push(data.charCodeAt(k) - R, data.charCodeAt(k + 1) - R);
    }
    if (current.length) strokes.push(current);
    glyphs.push([data.charCodeAt(0) - R, data.charCodeAt(1) - R, strokes]);
  }
  return glyphs;
}

const slot = (ch: string) => ch.charCodeAt(0) - 32;

/** Greek: ASCII A–X / a–x hold Hershey 527–550 / 627–650 (Alpha…Omega in alphabet order). */
const GREEK_UPPER = "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ";
const GREEK_LOWER = "αβγδεζηθικλμνξοπρστυφχψω";

/** mathupp slot → symbol, identified from a rendered contact sheet of the file. */
const MATH: Record<string, string> = {
  "!": "±",
  '"': "∓",
  "#": "×",
  $: "·",
  "&": "≤",
  "'": "≥",
  ":": "∏",
  ";": "∑",
  "?": "≠",
  "@": "≡",
  "^": "∝",
  _: "∞",
  "`": "°",
  c: "√",
  d: "⊂",
  e: "∪",
  f: "⊃",
  g: "∩",
  h: "∈",
  i: "→",
  j: "↑",
  k: "←",
  l: "↓",
  m: "∂",
  n: "∇",
  p: "∫",
  v: "∃",
  w: "ℵ",
  x: "÷",
  y: "‖",
  z: "⊥",
  "|": "∠",
  "~": "∴",
  "\u007f": "∼",
};

/**
 * Symbols the files lack, drawn in the same units (baseline y = 9, maths axis y = 0, operators
 * spanning x −9…9 like `=`).
 */
const SYNTHETIC: Record<string, Glyph> = {
  // Two tildes, a little flatter than ∼.
  "≈": [-13, 13, [tilde(-3), tilde(3)]],
  // Equilibrium: upper harpoon to the right, lower harpoon to the left.
  "⇌": [
    -13,
    13,
    [
      [-9, -2, 9, -2],
      [4, -6, 9, -2],
      [9, 2, -9, 2],
      [-4, 6, -9, 2],
    ],
  ],
  "⇒": [
    -13,
    13,
    [
      [-9, -3, 6, -3],
      [-9, 3, 6, 3],
      [3, -7, 9, 0, 3, 7],
    ],
  ],
  "↔": [
    -13,
    13,
    [
      [-9, 0, 9, 0],
      [-4, -5, -9, 0, -4, 5],
      [4, -5, 9, 0, 4, 5],
    ],
  ],
};

/** A small sine-like wave centred on y = dy, x −9…9. */
function tilde(dy: number): number[] {
  const points: number[] = [];
  for (let k = 0; k <= 12; k++) {
    const x = -9 + (18 * k) / 12;
    points.push(x, Math.round((dy - 2 * Math.sin((Math.PI * x) / 9)) * 10) / 10);
  }
  return points;
}

function main(): void {
  const dir = process.argv[2];
  if (!dir)
    throw new Error("usage: build-glyphs.ts <dir with futural.jhf, greeks.jhf, mathupp.jhf>");
  const futural = parseJhf(path.join(dir, "futural.jhf"));
  const greeks = parseJhf(path.join(dir, "greeks.jhf"));
  const math = parseJhf(path.join(dir, "mathupp.jhf"));

  const glyphs: Record<string, Glyph> = {};
  const take = (source: Glyph[], from: string, to: string) => {
    const glyph = source[slot(from)];
    if (!glyph) throw new Error(`missing slot ${JSON.stringify(from)}`);
    glyphs[to] = glyph;
  };

  for (let code = 32; code < 127; code++) {
    const ch = String.fromCharCode(code);
    take(futural, ch, ch);
  }
  [...GREEK_UPPER].forEach((g, i) => take(greeks, String.fromCharCode(65 + i), g));
  [...GREEK_LOWER].forEach((g, i) => take(greeks, String.fromCharCode(97 + i), g));
  for (const [from, to] of Object.entries(MATH)) take(math, from, to);
  Object.assign(glyphs, SYNTHETIC);

  const out = {
    source: `kamalmostafa/hershey-fonts@${SOURCE_COMMIT} (futural, greeks, mathupp) + synthetic ≈ ⇌ ⇒ ↔`,
    licence: "Hershey font licence; acknowledgements in NOTICE.md",
    units: { baseline: 9, xTop: -5, capTop: -12 },
    glyphs,
  };
  writeFileSync(OUT, `${JSON.stringify(out)}\n`);
  console.log(`wrote ${Object.keys(glyphs).length} glyphs to ${path.relative(process.cwd(), OUT)}`);
}

main();
