/**
 * Handwriting recognition eval (docs/NOTEBOOKS_K.md §8.1, K10): `pnpm eval:handwriting`.
 *
 * Every line of evals/handwriting/corpus.json is written by synthetic writers (writers.ts) and
 * by the real samples in evals/handwriting/samples/*.json, then read two ways:
 * - baseline: the pipeline before K10 (the line as drawn on the page, prompt recognition.v2);
 * - k10: the K10 pipeline (the line drawn from its strokes, deskewed, even pen; prompt
 *   recognition.v3 with the context block and top-3 readings; the reading chosen by logic).
 * Reported per category and neat/messy: exact lines, character and word error rate, SymPy
 * equivalence (maths and physics), formula match (chemistry), and a confusion table.
 *
 * Personalization (--personalize, on by default): writer w03's 7s look like 1s. Five of their
 * lines with a 7 are corrected (plus a calibration 7), and the held-out rest are read with and
 * without that profile.
 *
 * Flags: --limit=N lines per mode (default 180, stratified by category; --all for every line),
 * --no-personalize, --mode=baseline|k10. Needs GEMINI_API_KEY (skipped without). Replies are
 * cached in evals/.cache/handwriting; EVAL_NO_CACHE=1 skips the cache; EVAL_RPM paces calls
 * (default 12). SymPy runs through the API service when it's up (API_BASE_URL).
 * Writes evals/handwriting/reports/latest.{json,md}.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { bytesToBase64, encodePng, prepareLineAsDrawn, rasterize, recognitionPng } from "@mew/ink";
import {
  characterErrorRate,
  CONFUSION_PAIRS,
  type HandwritingSample,
  profileForRecognition,
  type Recognition,
  type RecognitionContext,
  sameFormula,
  sameLatex,
  substitutions,
  type Subject,
  wordErrorRate,
} from "@mew/shared";
import { z } from "zod";

import { seedOf, type Style, WRITERS, type WrittenLine, writeLine } from "./handwriting/writers";

const ROOT_ENV = path.resolve(import.meta.dirname, "../../.env.local");
if (existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);

if (!process.env.GEMINI_API_KEY) {
  console.log("eval:handwriting skipped — set GEMINI_API_KEY in .env.local.");
  process.exit(0);
}

const { recognizeHandwriting, recognizeLine } = await import("../src/server/recognition");
const { generateStructured, ModelBusyError } = await import("../src/server/gemini");
const { checkMathRemote } = await import("../src/server/solution");
const { checkEquivalence } = await import("../src/server/notes-check/equivalence");
const { geminiEnv } = await import("../src/server/env");
const MODEL = geminiEnv().GEMINI_GATE_MODEL;
type GenerateStructured = typeof generateStructured;

// ─── Flags ──────────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const LIMIT = argv.includes("--all") ? Infinity : Number(flag("limit") ?? "180");
const MODES = (flag("mode")?.split(",") ?? ["baseline", "k10"]) as Mode[];
const PERSONALIZE = !argv.includes("--no-personalize");
type Mode = "baseline" | "k10";

// ─── The corpus and its writers ─────────────────────────────────────────────────────────────

const Category = z.enum([
  "algebra",
  "fractions",
  "exponents",
  "calculus",
  "physics-units",
  "physics-vectors",
  "chemistry",
  "code",
  "prose",
]);
type Category = z.infer<typeof Category>;
const Problem = z.object({
  id: z.string(),
  category: Category,
  subject: z.string(),
  chapter: z.string(),
  problem: z.string(),
  lines: z.array(z.object({ text: z.string(), latex: z.string().nullable() })).min(1),
});
const DIR = path.resolve(import.meta.dirname, "handwriting");
const corpus = z
  .array(Problem)
  .parse(JSON.parse(readFileSync(path.join(DIR, "corpus.json"), "utf8")));

/** Real samples (the team, opt-in beta users): same shape as a written line, plus the truth. */
const RealSample = z.object({
  id: z.string(),
  category: Category,
  subject: z.string(),
  writer: z.string(),
  device: z.string(),
  style: z.enum(["neat", "messy"]),
  text: z.string(),
  latex: z.string().nullable(),
  previous: z.array(z.string()).default([]),
  problem: z.string().nullable().default(null),
  strokes: z.array(z.array(z.tuple([z.number(), z.number()])).min(1)).min(1),
});

type Sample = {
  id: string;
  category: Category;
  subject: Subject;
  writer: string;
  device: string;
  style: Style;
  synthetic: boolean;
  text: string;
  latex: string | null;
  context: RecognitionContext;
  strokes: WrittenLine;
};

function synthetic(): Sample[] {
  const out: Sample[] = [];
  for (const p of corpus) {
    p.lines.forEach((line, i) => {
      const previous = p.lines.slice(Math.max(0, i - 2), i).map((l) => l.latex ?? l.text);
      for (const writer of WRITERS) {
        const id = `${p.id}#${i}@${writer.id}`;
        const style: Style = seedOf(id) % 2 === 0 ? "neat" : "messy";
        out.push({
          id,
          category: p.category,
          subject: p.subject as Subject,
          writer: writer.id,
          device: writer.device,
          style,
          synthetic: true,
          text: line.text,
          latex: line.latex,
          context: {
            previous,
            problem: p.problem,
            subject: p.subject as Subject,
            vocabulary: [p.chapter],
          },
          strokes: writeLine(line, writer, style, seedOf(id)),
        });
      }
    });
  }
  return out;
}

function real(): Sample[] {
  const folder = path.join(DIR, "samples");
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) =>
      z.array(RealSample).parse(JSON.parse(readFileSync(path.join(folder, f), "utf8"))),
    )
    .map((s) => ({
      ...s,
      subject: s.subject as Subject,
      synthetic: false,
      context: {
        previous: s.previous.slice(-2),
        problem: s.problem,
        subject: s.subject as Subject,
        vocabulary: [],
      },
      strokes: s.strokes.map((pts) => ({
        points: pts.map(([x, y], i) => [x, y, 0.5, i * 8] as [number, number, number, number]),
        width: 2.5,
      })),
    }));
}

/** Up to `limit` samples, the same number from each category where possible (seeded). */
function stratified(samples: Sample[], limit: number): Sample[] {
  if (!Number.isFinite(limit)) return samples;
  const by = new Map<Category, Sample[]>();
  for (const s of [...samples].sort((a, b) => seedOf(a.id) - seedOf(b.id))) {
    by.set(s.category, [...(by.get(s.category) ?? []), s]);
  }
  const out: Sample[] = [];
  for (let round = 0; out.length < limit; round++) {
    let added = false;
    for (const list of by.values()) {
      const s = list[round];
      if (s && out.length < limit) {
        out.push(s);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

// ─── The model, cached and paced ────────────────────────────────────────────────────────────

const CACHE = path.resolve(import.meta.dirname, ".cache/handwriting");
mkdirSync(CACHE, { recursive: true });
const RPM = Number(process.env.EVAL_RPM ?? "12");
let nextCall = 0;
let modelCalls = 0;

const cachedGenerate: GenerateStructured = async (request) => {
  const key = createHash("sha256")
    .update(JSON.stringify([request.model, request.system, request.input]))
    .digest("hex")
    .slice(0, 32);
  const file = path.join(CACHE, `${key}.json`);
  if (!process.env.EVAL_NO_CACHE && existsSync(file)) {
    return request.schema.parse(JSON.parse(readFileSync(file, "utf8")));
  }
  for (let attempt = 0; ; attempt++) {
    if (RPM > 0) {
      const wait = nextCall - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      nextCall = Date.now() + 60_000 / RPM;
    }
    try {
      modelCalls++;
      const output = await generateStructured(request);
      writeFileSync(file, JSON.stringify(output));
      return output;
    } catch (error) {
      if (!(error instanceof ModelBusyError) || attempt >= 4) throw error;
      const wait = Math.min(error.retryAfterMs, 90_000);
      console.log(`  (model busy: waiting ${Math.ceil(wait / 1000)} s)`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
};

let sympyUp = true;
const checkMath: typeof checkMathRemote = async (steps) => {
  if (!sympyUp) return null;
  const result = await checkMathRemote(steps);
  if (result === null) {
    sympyUp = false;
    console.log("(SymPy unavailable: start the API service for the logic choice)");
  }
  return result;
};

// ─── Reading a sample ───────────────────────────────────────────────────────────────────────

async function image(sample: Sample, mode: Mode): Promise<string | null> {
  const deflate = (b: Uint8Array) => new Uint8Array(deflateSync(b));
  if (mode === "baseline") {
    const line = prepareLineAsDrawn(sample.strokes);
    return line ? bytesToBase64(await encodePng(rasterize(line), deflate)) : null;
  }
  const made = await recognitionPng(sample.strokes, deflate);
  return made ? bytesToBase64(made.png) : null;
}

async function read(
  sample: Sample,
  mode: Mode,
  profile?: { examples: { image: string; text: string }[]; note: string | null },
): Promise<Recognition | null> {
  const png = await image(sample, mode);
  if (!png) return null;
  try {
    if (mode === "baseline") return await recognizeHandwriting(png, cachedGenerate);
    return await recognizeLine(
      png,
      { context: sample.context, ...(profile ?? {}) },
      { generate: cachedGenerate, checkMath },
    );
  } catch (error) {
    console.log(`  ${sample.id}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ─── Scoring ────────────────────────────────────────────────────────────────────────────────

const SYMBOLS: Record<string, string> = {
  Omega: "Ω",
  omega: "ω",
  theta: "θ",
  Delta: "Δ",
  delta: "δ",
  pi: "π",
  rho: "ρ",
  mu: "μ",
  lambda: "λ",
  alpha: "α",
  beta: "β",
  times: "x",
  cdot: "x",
  div: "÷",
  int: "∫",
  rightarrow: "->",
  to: "->",
};

/**
 * Spacing, multiplication signs, dashes and LaTeX spellings of the same thing count as the same
 * ("\Omega" and "Ω", "F_y" and "Fy", "30^\circ" and "30°").
 */
function plain(s: string): string {
  return s
    .replace(/\^\{?(?:\\circ|o)\}?/g, "°")
    .replace(/\\(?:left|right|text|mathrm|operatorname)/g, "")
    .replace(/\\([A-Za-z]+)/g, (_, name: string) => SYMBOLS[name] ?? name)
    .replace(/[{}_]/g, "")
    .replace(/\s+/g, "")
    .replace(/[×·*]/g, "x")
    .replace(/[−–—]/g, "-")
    .replace(/→|⟶/g, "->")
    .replace(/\\?sqrt/g, "√")
    .toLowerCase();
}

/** As `plain`, but keeping spaces and case: for character and word error rates. */
function readable(s: string): string {
  return s
    .replace(/\^\{?(?:\\circ|o)\}?/g, "°")
    .replace(/\\(?:left|right|text|mathrm|operatorname)/g, "")
    .replace(/\\([A-Za-z]+)/g, (_, name: string) => SYMBOLS[name] ?? name)
    .replace(/[{}_]/g, "");
}

type Scored = {
  sample: Sample;
  mode: Mode;
  read: string;
  exact: boolean;
  cer: number;
  wer: number;
  formula: boolean | null;
  maths: string | null;
  equivalent: "equivalent" | "different" | "unknown" | null;
  chosenBy: string;
  confusions: string[];
};

function score(sample: Sample, mode: Mode, r: Recognition | null): Scored {
  const text = r?.text ?? "";
  const latex = r?.latex ?? null;
  const exact =
    plain(text) === plain(sample.text) ||
    (latex !== null && sample.latex !== null && sameLatex(latex, sample.latex));
  const confusions = substitutions(plain(text), plain(sample.text))
    .filter(([a, b]) =>
      CONFUSION_PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x)),
    )
    .map(([a, b]) => `${b}→${a}`);
  const isMaths = sample.subject === "math" || sample.subject === "physics";
  return {
    sample,
    mode,
    read: text,
    exact,
    cer: characterErrorRate(readable(sample.text), readable(text)),
    wer: wordErrorRate(readable(sample.text), readable(text)),
    formula:
      sample.category === "chemistry"
        ? sameFormula(latex ?? text, sample.latex ?? sample.text) ||
          plain(text) === plain(sample.text)
        : null,
    maths: isMaths && r ? (latex ?? text) : null,
    equivalent: null,
    chosenBy: r?.chosenBy ?? (r ? "model" : "failed"),
    confusions,
  };
}

async function settleEquivalence(scored: Scored[]): Promise<void> {
  const pending = scored.filter((s) => s.maths !== null && s.sample.latex);
  for (let i = 0; i < pending.length; i += 20) {
    const batch = pending.slice(i, i + 20);
    let verdicts: ("equivalent" | "different" | "unknown")[];
    try {
      verdicts = await checkEquivalence(
        batch.map((s) => ({ note: s.maths ?? "", screen: s.sample.latex ?? "" })),
      );
    } catch {
      verdicts = batch.map(() => "unknown");
    }
    batch.forEach((s, j) => {
      // An exact reading is equivalent whatever SymPy can parse.
      s.equivalent = s.exact ? "equivalent" : (verdicts[j] ?? "unknown");
    });
  }
}

type Row = {
  n: number;
  exact: number;
  cer: number;
  wer: number;
  equivalence: number | null;
  equivalenceUnknown: number;
  formula: number | null;
};

function summarize(rows: Scored[]): Row {
  const n = rows.length;
  const mean = (f: (s: Scored) => number) => (n ? rows.reduce((t, s) => t + f(s), 0) / n : 0);
  const maths = rows.filter((s) => s.equivalent !== null);
  const chem = rows.filter((s) => s.formula !== null);
  return {
    n,
    exact: mean((s) => (s.exact ? 1 : 0)),
    cer: mean((s) => s.cer),
    wer: mean((s) => s.wer),
    equivalence: maths.length
      ? maths.filter((s) => s.equivalent === "equivalent").length / maths.length
      : null,
    equivalenceUnknown: maths.filter((s) => s.equivalent === "unknown").length,
    formula: chem.length ? chem.filter((s) => s.formula).length / chem.length : null,
  };
}

// ─── Personalization: a writer whose 7s look like 1s ────────────────────────────────────────

const sevens = (s: string) => [...s].filter((c) => c === "7").length;

/** Of the truth's 7s, how many were read as 7 (an aligned substitution is a miss). */
function sevensRight(truth: string, read: string): { right: number; total: number } {
  const total = sevens(plain(truth));
  if (!read) return { right: 0, total };
  const missed = substitutions(plain(read), plain(truth)).filter(
    ([, meant]) => meant === "7",
  ).length;
  const dropped = Math.max(0, total - sevens(plain(read)) - missed);
  return { right: Math.max(0, total - missed - dropped), total };
}

async function personalization() {
  const lines = synthetic()
    .filter((s) => s.writer === "w03" && sevens(s.text) > 0 && s.category !== "code")
    .sort((a, b) => a.id.localeCompare(b.id));
  const train = lines.slice(0, 5);
  const heldOut = lines.slice(5, 30);
  const deflate = (b: Uint8Array) => new Uint8Array(deflateSync(b));
  const samples: HandwritingSample[] = [];
  let t = 0;
  // Calibration: the writer's own "7" on its own.
  const writer = WRITERS.find((w) => w.id === "w03");
  if (!writer) throw new Error("writer w03 is missing");
  const calibration = {
    ...(lines[0] as Sample),
    id: "calibration-7",
    text: "7",
    latex: "7",
    context: { previous: [], problem: null, subject: null, vocabulary: [] },
    strokes: writeLine({ text: "7", latex: "7" }, writer, "neat", 7),
  };
  for (const s of [calibration, ...train]) {
    const r = await read(s, "k10");
    const made = await recognitionPng(s.strokes, deflate);
    if (!made) continue;
    samples.push({
      id: crypto.randomUUID(),
      text: s.text,
      latex: s.latex,
      readAs: r && plain(r.text) !== plain(s.text) ? r.text : null,
      source: s.id === "calibration-7" ? "calibration" : "fix",
      image: bytesToBase64(made.png),
      createdAt: ++t,
    });
  }
  const profile = profileForRecognition(samples);
  const run = async (withProfile: boolean) => {
    let right = 0;
    let total = 0;
    let exact = 0;
    for (const s of heldOut) {
      const r = await read(s, "k10", withProfile ? profile : undefined);
      const counted = sevensRight(s.text, r?.text ?? "");
      right += counted.right;
      total += counted.total;
      if (r && plain(r.text) === plain(s.text)) exact++;
    }
    return { sevens: total ? right / total : 0, sevenCount: total, exact: exact / heldOut.length };
  };
  return {
    corrections: samples.map((s) => ({ text: s.text, readAs: s.readAs, source: s.source })),
    note: profile.note,
    heldOut: heldOut.length,
    without: await run(false),
    with: await run(true),
  };
}

// ─── Run ────────────────────────────────────────────────────────────────────────────────────

const all = [...synthetic(), ...real()];
const chosen = stratified(all, LIMIT);
console.log(
  `Handwriting eval: ${all.length} lines (${all.filter((s) => !s.synthetic).length} real), ` +
    `reading ${chosen.length} per mode with ${MODES.join(" and ")}.`,
);

const scored: Scored[] = [];
for (const mode of MODES) {
  let done = 0;
  for (const sample of chosen) {
    scored.push(score(sample, mode, await read(sample, mode)));
    if (++done % 20 === 0) console.log(`  ${mode}: ${done}/${chosen.length}`);
  }
}
await settleEquivalence(scored);

const categories = Category.options;
const table: Record<Mode, Record<string, Row>> = { baseline: {}, k10: {} };
for (const mode of MODES) {
  const rows = scored.filter((s) => s.mode === mode);
  table[mode].all = summarize(rows);
  for (const style of ["neat", "messy"] as const) {
    table[mode][style] = summarize(rows.filter((s) => s.sample.style === style));
  }
  for (const c of categories) {
    table[mode][c] = summarize(rows.filter((s) => s.sample.category === c));
    for (const style of ["neat", "messy"] as const) {
      table[mode][`${c}/${style}`] = summarize(
        rows.filter((s) => s.sample.category === c && s.sample.style === style),
      );
    }
  }
}
const confusion: Record<Mode, Record<string, number>> = { baseline: {}, k10: {} };
for (const s of scored) {
  for (const c of s.confusions) confusion[s.mode][c] = (confusion[s.mode][c] ?? 0) + 1;
}
const chosenBy: Record<string, number> = {};
for (const s of scored.filter((x) => x.mode === "k10")) {
  chosenBy[s.chosenBy] = (chosenBy[s.chosenBy] ?? 0) + 1;
}

const personal = PERSONALIZE ? await personalization() : null;

// ─── Report ─────────────────────────────────────────────────────────────────────────────────

const pct = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(1)}%`);
const md: string[] = [
  "# Handwriting eval report",
  "",
  `Run ${new Date().toISOString().slice(0, 16)}Z · model \`${MODEL}\` · ` +
    `${chosen.length} lines per mode (of ${all.length}; ${all.filter((s) => !s.synthetic).length} real) · ` +
    `${modelCalls} model calls (the rest cached) · SymPy ${sympyUp ? "up" : "down"}.`,
  "",
  "Synthetic writers only, unless real samples are counted above: these numbers measure the",
  "pipeline, not real students (see evals/handwriting/README.md).",
  "",
  "## Per category",
  "",
  "| Category | Mode | n | Exact | CER | WER | SymPy equiv. | Formula |",
  "|---|---|---|---|---|---|---|---|",
];
for (const c of ["all", "neat", "messy", ...categories]) {
  for (const mode of MODES) {
    const r = table[mode][c];
    if (!r || r.n === 0) continue;
    md.push(
      `| ${c} | ${mode} | ${r.n} | ${pct(r.exact)} | ${pct(r.cer)} | ${pct(r.wer)} | ` +
        `${pct(r.equivalence)}${r.equivalenceUnknown ? ` (${r.equivalenceUnknown} unknown)` : ""} | ${pct(r.formula)} |`,
    );
  }
}
md.push("", "## Maths equivalence, neat and messy", "", "| | baseline | k10 |", "|---|---|---|");
for (const style of ["neat", "messy"] as const) {
  const eq = (mode: Mode) => {
    const rows = scored.filter(
      (s) => s.mode === mode && s.sample.style === style && s.equivalent !== null,
    );
    return rows.length
      ? rows.filter((s) => s.equivalent === "equivalent").length / rows.length
      : null;
  };
  md.push(`| ${style} | ${pct(eq("baseline"))} | ${pct(eq("k10"))} |`);
}
md.push("", "## Confusions (truth → read)", "", "| Pair | baseline | k10 |", "|---|---|---|");
const pairs = new Set([...Object.keys(confusion.baseline), ...Object.keys(confusion.k10)]);
for (const p of [...pairs].sort()) {
  md.push(`| ${p} | ${confusion.baseline[p] ?? 0} | ${confusion.k10[p] ?? 0} |`);
}
if (pairs.size === 0) md.push("| (none) | 0 | 0 |");
md.push("", `K10 readings chosen by: ${JSON.stringify(chosenBy)}.`);
if (personal) {
  md.push(
    "",
    "## Personalization: writer w03 (their 7 looks like a 1)",
    "",
    `Profile: ${personal.corrections.length} samples (1 calibration "7" and 5 corrected lines).`,
    `Note sent: ${personal.note ? `\`${personal.note}\`` : "none"}.`,
    "",
    `| Held-out lines (${personal.heldOut}) | 7s read as 7 | Exact lines |`,
    "|---|---|---|",
    `| without the profile | ${pct(personal.without.sevens)} of ${personal.without.sevenCount} | ${pct(personal.without.exact)} |`,
    `| with the profile | ${pct(personal.with.sevens)} of ${personal.with.sevenCount} | ${pct(personal.with.exact)} |`,
  );
}

const REPORTS = path.join(DIR, "reports");
mkdirSync(REPORTS, { recursive: true });
writeFileSync(path.join(REPORTS, "latest.md"), `${md.join("\n")}\n`);
writeFileSync(
  path.join(REPORTS, "latest.json"),
  `${JSON.stringify(
    {
      model: MODEL,
      lines: chosen.length,
      table,
      confusion,
      chosenBy,
      personalization: personal,
      misses: scored
        .filter((s) => !s.exact)
        .map((s) => ({ id: s.sample.id, mode: s.mode, truth: s.sample.text, read: s.read })),
    },
    null,
    1,
  )}\n`,
);
console.log(md.join("\n"));
