/**
 * Synthetic writers for the handwriting eval (K10 §8.1). Each line of the corpus is typeset in
 * single-stroke glyphs (the tutor's own Hershey handwriting), then written by a "writer": a slant,
 * a size, a wobbly baseline, letters that lean and shrink on their own, pen noise, a device
 * (a pen samples densely; a mouse is sparse and jittery), and sometimes a quirk (a 7 that looks
 * like a 1, a z that looks like a 2). Seeded, so a run is repeatable.
 *
 * These are not real students' handwriting: they're cleaner than most and their errors are
 * ours. They measure the pipeline and catch regressions; real samples (evals/handwriting/samples,
 * from the team and opt-in beta users) are what the targets are finally judged on.
 */
import {
  FONT_METRICS,
  type Glyph,
  glyph,
  type Mark,
  typesetLatex,
  typesetText,
  withGlyphOverrides,
} from "@mew/ink";

export type Device = "pen" | "mouse";
export type Style = "neat" | "messy";

export type Writer = {
  id: string;
  slant: number;
  /** Page units per x-height. */
  size: number;
  device: Device;
  quirks: readonly Quirk[];
};

export type Quirk = "seven-like-one" | "z-like-two";

/** A written line: strokes in page units (as the notebook keeps them). */
export type WrittenLine = { points: [number, number, number, number][]; width: number }[];

export const WRITERS: readonly Writer[] = [
  { id: "w01", slant: 0.05, size: 9, device: "pen", quirks: [] },
  { id: "w02", slant: 0.22, size: 11, device: "pen", quirks: [] },
  { id: "w03", slant: 0.12, size: 10, device: "pen", quirks: ["seven-like-one"] },
  { id: "w04", slant: -0.08, size: 8, device: "mouse", quirks: [] },
  { id: "w05", slant: 0.3, size: 12, device: "pen", quirks: [] },
  { id: "w06", slant: 0.0, size: 9, device: "mouse", quirks: [] },
  { id: "w07", slant: 0.15, size: 14, device: "pen", quirks: [] },
  { id: "w08", slant: 0.1, size: 10, device: "pen", quirks: ["z-like-two"] },
  { id: "w09", slant: -0.15, size: 9, device: "pen", quirks: [] },
  { id: "w10", slant: 0.18, size: 8, device: "mouse", quirks: [] },
];

const NOISE: Record<
  Style,
  { point: number; tilt: number; scale: number; wave: number; drift: number }
> = {
  neat: { point: 0.012, tilt: 0.03, scale: 0.04, wave: 0.03, drift: 0.02 },
  messy: { point: 0.04, tilt: 0.12, scale: 0.14, wave: 0.12, drift: 0.07 },
};

/** A small, fast seeded generator (mulberry32). */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
}

/** The quirky glyphs a writer draws instead of the font's. */
function quirkGlyphs(quirks: readonly Quirk[]): Map<string, Glyph> {
  const map = new Map<string, Glyph>();
  const cap = FONT_METRICS.capHeight;
  if (quirks.includes("seven-like-one")) {
    const seven = glyph("7");
    const a = seven?.advance ?? 0.9;
    // A tiny flag and a near-upright stem: how many people's 7 looks like a 1.
    map.set("7", { advance: a, strokes: [[a * 0.38, -cap * 0.92, a * 0.6, -cap, a * 0.5, 0]] });
  }
  if (quirks.includes("z-like-two")) {
    const two = glyph("2");
    if (two) {
      // A 2 shrunk to the x-height: a curved top where a z has a bar.
      const k = 1 / cap;
      map.set("z", {
        advance: two.advance * k,
        strokes: two.strokes.map((s) => s.map((v) => v * k)),
      });
    }
  }
  return map;
}

/** The line's marks, typeset as LaTeX for maths and chemistry, otherwise as text. */
function marksOf(text: string, latex: string | null, quirks: readonly Quirk[]): readonly Mark[] {
  return withGlyphOverrides(quirkGlyphs(quirks), () =>
    latex ? typesetLatex(latex).box.marks : typesetText(text).box.marks,
  );
}

/** One corpus line, written by `writer` in `style`. */
export function writeLine(
  line: { text: string; latex: string | null },
  writer: Writer,
  style: Style,
  seed: number,
): WrittenLine {
  const rand = random(seed);
  const noise = NOISE[style];
  const size = writer.size * (1 + (rand() - 0.5) * 0.15);
  const slant = writer.slant + gaussian(rand) * noise.drift;
  const marks = marksOf(line.text, line.latex, writer.quirks);
  const wavePhase = rand() * Math.PI * 2;
  const strokes: WrittenLine = [];
  let t = 0;
  let drift = 0;

  for (const mark of marks) {
    const tilt = gaussian(rand) * noise.tilt;
    const scale = 1 + gaussian(rand) * noise.scale;
    drift += gaussian(rand) * noise.drift * 0.3;
    const [px, py] = mark.pivot;
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);
    for (const flat of mark.strokes) {
      const raw: [number, number][] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const x0 = (flat[i] as number) - px;
        const y0 = (flat[i + 1] as number) - py;
        // Each letter leans and grows on its own, around its pivot.
        let x = px + (x0 * cos - y0 * sin) * scale;
        let y = py + (x0 * sin + y0 * cos) * scale;
        // The writer's slant (a shear) and a gently wandering baseline.
        x -= y * slant;
        y += Math.sin(x * 0.35 + wavePhase) * noise.wave + drift;
        raw.push([x * size, y * size]);
      }
      const sampled = resample(raw, writer.device === "pen" ? 0.9 : 2.6, rand, writer.device);
      // A hand wobbles slowly, it doesn't shiver: noise smoothed along the stroke.
      const nx = smooth(
        sampled.map(() => gaussian(rand)),
        6,
      );
      const ny = smooth(
        sampled.map(() => gaussian(rand)),
        6,
      );
      const amount = noise.point * size * 2.5;
      const points = sampled.map(([x, y], i) => {
        t += writer.device === "pen" ? 8 : 16;
        return [x + (nx[i] ?? 0) * amount, y + (ny[i] ?? 0) * amount, 0.5, t] as [
          number,
          number,
          number,
          number,
        ];
      });
      if (points.length > 0) strokes.push({ points, width: 2.5 });
      t += 120;
    }
  }
  return strokes;
}

/** A moving average over `radius` points either side. */
function smooth(values: readonly number[], radius: number): number[] {
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      sum += values[j] as number;
      n++;
    }
    return sum / n;
  });
}

/** Points every `step` page units along a polyline (a mouse adds jitter between them). */
function resample(
  pts: readonly [number, number][],
  step: number,
  rand: () => number,
  device: Device,
): [number, number][] {
  if (pts.length < 2) return pts.map((p) => [p[0], p[1]]);
  const out: [number, number][] = [[pts[0]?.[0] ?? 0, pts[0]?.[1] ?? 0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1] as [number, number];
    const [bx, by] = pts[i] as [number, number];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) {
      const jitter = device === "mouse" ? (rand() - 0.5) * step * 0.4 : 0;
      out.push([ax + ((bx - ax) * k) / n + jitter, ay + ((by - ay) * k) / n + jitter]);
    }
  }
  return out;
}
