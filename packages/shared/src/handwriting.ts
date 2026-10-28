import { z } from "zod";

import { checkBalance, looksLikeReaction } from "./chemistry";
import { Subject } from "./subject";
import type { Recognition } from "./tutor";

/**
 * Handwriting recognition, K10 (docs/NOTEBOOKS_K.md §8): what a line is read with (its context),
 * the model's top readings and how one is chosen, and each student's handwriting profile (their
 * own corrected samples and the confusions they show).
 */

export const HANDWRITING_LIMITS = {
  /** A line's picture in a recognition request: TUTOR_LIMITS.imageBase64Chars (kept equal by a test). */
  requestImageChars: 1_500_000,
  previousLines: 2,
  lineChars: 300,
  problemChars: 300,
  vocabulary: 40,
  termChars: 40,
  readings: 3,
  /** A sample's picture: one line at most, mostly white (base64 PNG). */
  sampleImageChars: 120_000,
  /** Few-shot examples sent with a recognition call. */
  fewShot: 6,
  /** Kept per student; the oldest go first. */
  samplesPerUser: 300,
  /** Samples sent at once (calibration). */
  samplesPerRequest: 40,
  confusionNotes: 4,
  /** A reading other than the model's first is only chosen this close to it in confidence. */
  choiceMargin: 0.35,
  /** …and never below this. */
  choiceFloor: 0.2,
} as const;

const PlainText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((text) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text), {
      message: "control characters aren't allowed",
    });

const PngBase64 = (max: number) =>
  z
    .string()
    .min(8)
    .max(max)
    .regex(/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/, "a base64 PNG");

// ─── Context and readings ─────────────────────────────────────────────────────────────────────

/** What surrounds a line (§8.2): it helps tell look-alike characters apart. Data, never orders. */
export const RecognitionContext = z.object({
  /** The 2 lines above it, as read (oldest first). */
  previous: z.array(PlainText(HANDWRITING_LIMITS.lineChars)).max(HANDWRITING_LIMITS.previousLines),
  /** The problem being worked on (the page's first line, a Your Turn, a clip's question). */
  problem: PlainText(HANDWRITING_LIMITS.problemChars).nullable(),
  subject: Subject.nullable(),
  /** Variable names, units, species and terms of the chapter. */
  vocabulary: z
    .array(PlainText(HANDWRITING_LIMITS.termChars).pipe(z.string().min(1)))
    .max(HANDWRITING_LIMITS.vocabulary),
});
export type RecognitionContext = z.infer<typeof RecognitionContext>;

/** `POST /api/recognize` (K10): the line's picture and, from K10 on, its context. */
export const RecognizeLineRequest = z.object({
  image: z.string().min(1).max(HANDWRITING_LIMITS.requestImageChars),
  context: RecognitionContext.optional(),
});
export type RecognizeLineRequest = z.infer<typeof RecognizeLineRequest>;

export const EMPTY_CONTEXT: RecognitionContext = {
  previous: [],
  problem: null,
  subject: null,
  vocabulary: [],
};

export const RecognitionReading = z.object({
  text: z.string().max(HANDWRITING_LIMITS.lineChars),
  latex: z.string().max(HANDWRITING_LIMITS.lineChars).nullable(),
  confidence: z.number().min(0).max(1),
});
export type RecognitionReading = z.infer<typeof RecognitionReading>;

/** What the model returns (prompt recognition.v3): up to 3 different readings, best first. */
export const RecognitionReadings = z.object({
  readings: z.array(RecognitionReading).min(1).max(HANDWRITING_LIMITS.readings),
  subject: Subject,
});
export type RecognitionReadings = z.infer<typeof RecognitionReadings>;

/** How the reading used was picked (§8.2 "choose with logic"). */
export const ChosenBy = z.enum(["model", "math", "chemistry", "code"]);
export type ChosenBy = z.infer<typeof ChosenBy>;

export type ReadingChecks = {
  /**
   * SymPy's verdicts on consecutive LaTeX lines (`/v1/check/math`), or null when it can't be
   * reached. Each line is checked against the one before it.
   */
  checkMath?(steps: string[]): Promise<{ index: number; verdict: string; reason: string }[] | null>;
};

const MATH_SUBJECTS = new Set<Subject>(["math", "physics"]);

/**
 * Picks a reading with logic, not only the model's first choice (§8.2):
 * - maths: the reading that's a correct step from the line before (SymPy), else one SymPy can
 *   parse when the first can't;
 * - chemistry: a reading that's a valid formula or equation;
 * - code: a reading whose brackets and quotes balance.
 * Only readings close to the first in confidence are considered, so logic settles look-alikes
 * (1 / 7, x / ×) without talking a real mistake away. Otherwise the model's first reading.
 */
export async function chooseReading(
  output: RecognitionReadings,
  context: RecognitionContext,
  checks: ReadingChecks = {},
): Promise<{
  reading: RecognitionReading;
  alternatives: RecognitionReading[];
  chosenBy: ChosenBy;
}> {
  const sorted = distinct(output.readings).sort((a, b) => b.confidence - a.confidence);
  const top = sorted[0] as RecognitionReading;
  const pick = (reading: RecognitionReading, chosenBy: ChosenBy) => ({
    reading,
    alternatives: sorted.filter((r) => r !== reading),
    chosenBy,
  });
  const close = sorted.filter(
    (r) =>
      r.text.trim() !== "" &&
      r.confidence >=
        Math.max(HANDWRITING_LIMITS.choiceFloor, top.confidence - HANDWRITING_LIMITS.choiceMargin),
  );
  if (close.length < 2) return pick(top, "model");

  const subject = context.subject ?? output.subject;
  if (subject === "chemistry") {
    const valid = close.find((r) => validChemistry(r.latex ?? r.text));
    if (valid && !validChemistry(top.latex ?? top.text)) return pick(valid, "chemistry");
    return pick(top, "model");
  }
  if (subject === "programming") {
    const parses = close.find((r) => balanced(r.text));
    if (parses && !balanced(top.text)) return pick(parses, "code");
    return pick(top, "model");
  }
  const previous = context.previous.at(-1);
  if ((MATH_SUBJECTS.has(subject) || close.some((r) => r.latex)) && checks.checkMath) {
    const lines = close.map((r) => r.latex ?? r.text);
    // One call: [previous, a, previous, b, …] checks each reading against the line above, and
    // each reading's own parse ([a] alone when there's no line above).
    const steps = previous ? lines.flatMap((l) => [previous, l]) : lines;
    const results = await checks.checkMath(steps.slice(0, 8));
    if (results) {
      const verdict = (i: number) => results.find((r) => r.index === (previous ? 2 * i + 1 : i));
      const correct = close.findIndex((_, i) => verdict(i)?.verdict === "correct");
      if (correct > 0) return pick(close[correct] as RecognitionReading, "math");
      if (correct === 0) return pick(top, "model");
      const unparseable = (i: number) => verdict(i)?.reason === "unparseable";
      if (unparseable(0)) {
        const parses = close.findIndex((_, i) => i > 0 && verdict(i) && !unparseable(i));
        if (parses > 0) return pick(close[parses] as RecognitionReading, "math");
      }
    }
  }
  return pick(top, "model");
}

/** The chosen reading as the rest of the app knows a recognition. */
export function toRecognition(
  chosen: Awaited<ReturnType<typeof chooseReading>>,
  subject: Subject,
): Recognition {
  const { reading } = chosen;
  const blank = reading.text.trim() === "";
  return {
    text: reading.text,
    latex: reading.latex,
    subject,
    confidence: blank ? 0 : reading.confidence,
    ...(chosen.alternatives.length > 0 ? { alternatives: chosen.alternatives.slice(0, 2) } : {}),
    chosenBy: chosen.chosenBy,
  };
}

function distinct(readings: readonly RecognitionReading[]): RecognitionReading[] {
  const seen = new Set<string>();
  return readings.filter((r) => {
    const key = `${r.text.trim()}\u0000${r.latex?.trim() ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const ELEMENTS = new Set(
  (
    "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se " +
    "Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb " +
    "Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm " +
    "Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og"
  ).split(" "),
);

/** A formula or an equation made of real elements that parses. */
export function validChemistry(input: string): boolean {
  const plain = input
    .replace(/\\(?:mathrm|text)\{([^}]*)\}/g, "$1")
    .replace(/\\(?:rightleftharpoons|rightarrow|longrightarrow|to)/g, "->")
    .replace(/[_{}\s]/g, "");
  const symbols = plain.match(/[A-Z][a-z]?/g) ?? [];
  if (symbols.length === 0 || symbols.some((s) => !ELEMENTS.has(s))) return false;
  if (looksLikeReaction(input)) return checkBalance(input).verdict !== "unknown";
  // Counts never start with 0 ("C02" is a misread "CO2").
  const count = "([1-9]\\d*)?";
  return new RegExp(`^${count}([A-Z][a-z]?${count}|\\(|\\)${count}|\\^?\\d*[+-]|·${count})+$`).test(
    plain,
  );
}

/** Brackets and quotes balance: a quick "does it parse" for a line of code. */
export function balanced(code: string): boolean {
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i] as string;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") stack.push(c);
    else if (c in pairs && stack.pop() !== pairs[c]) return false;
  }
  return quote === null && stack.length === 0;
}

// ─── The handwriting profile (§8.3) ───────────────────────────────────────────────────────────

/** Where a sample came from. */
export const HandwritingSampleSource = z.enum(["calibration", "fix", "confirm", "not_wrong"]);
export type HandwritingSampleSource = z.infer<typeof HandwritingSampleSource>;

/** One sample: the student's writing (a picture, made as recognition makes it) and what it says. */
export const HandwritingSampleInput = z.object({
  id: z.uuid(),
  /** What it really says. */
  text: PlainText(HANDWRITING_LIMITS.lineChars).pipe(z.string().min(1)),
  latex: PlainText(HANDWRITING_LIMITS.lineChars).nullable(),
  /** What neb read before it was corrected (null: not read, or read right). */
  readAs: PlainText(HANDWRITING_LIMITS.lineChars).nullable(),
  source: HandwritingSampleSource,
  image: PngBase64(HANDWRITING_LIMITS.sampleImageChars),
});
export type HandwritingSampleInput = z.infer<typeof HandwritingSampleInput>;

export const HandwritingSampleRequest = z.object({
  samples: z.array(HandwritingSampleInput).min(1).max(HANDWRITING_LIMITS.samplesPerRequest),
});
export type HandwritingSampleRequest = z.infer<typeof HandwritingSampleRequest>;

/** A stored sample, as the server keeps it. */
export const HandwritingSample = HandwritingSampleInput.extend({ createdAt: z.number().int() });
export type HandwritingSample = z.infer<typeof HandwritingSample>;

export const HandwritingSamples = z.object({ samples: z.array(HandwritingSample) });

/** One look-alike this student's writing gets read as. */
export const Confusion = z.object({ read: z.string(), meant: z.string(), count: z.number().int() });
export type Confusion = z.infer<typeof Confusion>;

/** Settings → Handwriting: "neb has learned 42 things about your handwriting". */
export const HandwritingProfileSummary = z.object({
  learned: z.number().int().nonnegative(),
  confusions: z.array(Confusion),
  calibrated: z.boolean(),
});
export type HandwritingProfileSummary = z.infer<typeof HandwritingProfileSummary>;

/**
 * The characters read wrong in each correction: `readAs` aligned with `text`, one count per
 * substitution (whitespace aside). Most frequent first.
 */
export function confusionsOf(
  samples: readonly Pick<HandwritingSample, "text" | "readAs">[],
): Confusion[] {
  const counts = new Map<string, Confusion>();
  for (const s of samples) {
    if (!s.readAs || s.readAs === s.text) continue;
    for (const [read, meant] of substitutions(strip(s.readAs), strip(s.text))) {
      const key = `${read}\u0000${meant}`;
      const c = counts.get(key) ?? { read, meant, count: 0 };
      c.count++;
      counts.set(key, c);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.meant.localeCompare(b.meant));
}

/**
 * A short note for the prompt (§8.3): "When this student writes 7 it can look like 1." Only
 * confusions seen at least twice, or once when the student calibrated.
 */
export function confusionNote(confusions: readonly Confusion[], min = 2): string | null {
  const lines = confusions
    .filter((c) => c.count >= min)
    .slice(0, HANDWRITING_LIMITS.confusionNotes)
    .map((c) => `- This student's "${c.meant}" can look like "${c.read}".`);
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * The few-shot examples for a recognition call (§8.3): corrections that show the student's own
 * look-alikes first (the confusions seen most), then calibration samples of those characters,
 * then the most recent corrections. At most HANDWRITING_LIMITS.fewShot, each text once.
 */
export function pickExamples<
  S extends Pick<HandwritingSample, "text" | "readAs" | "source" | "createdAt">,
>(samples: readonly S[], limit: number = HANDWRITING_LIMITS.fewShot): S[] {
  const confusions = confusionsOf(samples);
  const chars = confusions.map((c) => c.meant);
  const weight = (s: S): number => {
    const corrected = s.readAs !== null && s.readAs !== s.text;
    const shows = chars.findIndex((c) => s.text.includes(c));
    const base = corrected ? 3 : s.source === "calibration" ? 2 : 1;
    return base * 100 + (shows === -1 ? 0 : 50 - shows);
  };
  const ranked = [...samples].sort((a, b) => weight(b) - weight(a) || b.createdAt - a.createdAt);
  const out: S[] = [];
  const texts = new Set<string>();
  for (const s of ranked) {
    if (texts.has(s.text)) continue;
    texts.add(s.text);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/** What a recognition call gets from a profile (§8.3): the examples and the confusion note. */
export function profileForRecognition(
  samples: readonly Pick<HandwritingSample, "text" | "readAs" | "source" | "createdAt" | "image">[],
): { examples: { image: string; text: string }[]; note: string | null } {
  if (samples.length === 0) return { examples: [], note: null };
  const calibrated = samples.some((s) => s.source === "calibration");
  return {
    examples: pickExamples(samples).map((s) => ({ image: s.image, text: s.text })),
    note: confusionNote(confusionsOf(samples), calibrated ? 1 : 2),
  };
}

/** Settings → Handwriting: what neb has learned (never the pictures). */
export function summarizeProfile(
  samples: readonly Pick<HandwritingSample, "text" | "readAs" | "source">[],
): HandwritingProfileSummary {
  return {
    learned: samples.length,
    confusions: confusionsOf(samples).slice(0, 8),
    calibrated: samples.some((s) => s.source === "calibration"),
  };
}

/** Calibration (§8.3): what the student writes, one box each. */
export const CALIBRATION_PROMPTS: readonly { text: string; latex: string | null }[] = [
  ..."0123456789".split("").map((d) => ({ text: d, latex: d })),
  ..."xyztn".split("").map((c) => ({ text: c, latex: c })),
  { text: "+", latex: "+" },
  { text: "−", latex: "-" },
  { text: "×", latex: "\\times" },
  { text: "÷", latex: "\\div" },
  { text: "=", latex: "=" },
  { text: "(", latex: "(" },
  { text: ")", latex: ")" },
  { text: "√", latex: "\\sqrt{}" },
  { text: "∫", latex: "\\int" },
  { text: "π", latex: "\\pi" },
  { text: "θ", latex: "\\theta" },
  { text: "Δ", latex: "\\Delta" },
  { text: "The quick brown fox jumps over the lazy dog.", latex: null },
];

// ─── Measuring (§8.1) ─────────────────────────────────────────────────────────────────────────

/** Edit distance between two sequences. */
export function editDistance<T>(a: readonly T[], b: readonly T[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length] as number;
}

/** Character error rate of a reading against the truth (whitespace runs count as one space). */
export function characterErrorRate(truth: string, read: string): number {
  const t = Array.from(squash(truth));
  return t.length === 0
    ? read.trim()
      ? 1
      : 0
    : editDistance(t, Array.from(squash(read))) / t.length;
}

export function wordErrorRate(truth: string, read: string): number {
  const t = squash(truth).split(" ").filter(Boolean);
  const r = squash(read).split(" ").filter(Boolean);
  return t.length === 0 ? (r.length ? 1 : 0) : editDistance(t, r) / t.length;
}

/** LaTeX compared without spacing, \left/\right and redundant braces around one character. */
export function sameLatex(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .replace(/\\(left|right)/g, "")
      .replace(/\\[,;:! ]/g, "")
      .replace(/\s+/g, "")
      .replace(/\{(\w)\}/g, "$1")
      .replace(/\\cdot|\\times/g, "×")
      .replace(/\\div/g, "÷");
  return norm(a) === norm(b);
}

/** Chemical formulas compared without spacing and LaTeX subscripts. */
export function sameFormula(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .replace(/\\(?:mathrm|text)\{([^}]*)\}/g, "$1")
      .replace(/\\(?:rightarrow|longrightarrow|to)|→|⟶/g, "->")
      .replace(/[_{}\s]/g, "");
  return norm(a) === norm(b);
}

/** The look-alikes the eval reports on (§8.1). */
export const CONFUSION_PAIRS: readonly (readonly [string, string])[] = [
  ["x", "×"],
  ["1", "l"],
  ["1", "|"],
  ["1", "7"],
  ["5", "S"],
  ["2", "z"],
  ["0", "O"],
  ["t", "+"],
  ["−", "–"],
];

/** Each character substitution between a reading and the truth, as [read, meant]. */
export function substitutions(read: string, truth: string): [string, string][] {
  const a = Array.from(read);
  const b = Array.from(truth);
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[];
      const up = d[i - 1] as number[];
      row[j] = Math.min(
        (up[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (up[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  const out: [string, string][] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    const here = (d[i] as number[])[j] as number;
    const diag = (d[i - 1] as number[])[j - 1] as number;
    if (a[i - 1] === b[j - 1] && here === diag) {
      i--;
      j--;
    } else if (here === diag + 1) {
      out.push([a[i - 1] as string, b[j - 1] as string]);
      i--;
      j--;
    } else if (here === ((d[i - 1] as number[])[j] as number) + 1) {
      i--;
    } else {
      j--;
    }
  }
  return out.reverse();
}

function squash(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function strip(s: string): string {
  return s.replace(/\s+/g, "");
}
