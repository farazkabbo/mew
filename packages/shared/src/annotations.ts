import { z } from "zod";

import { Evidence } from "./learner";
import { BBox, LiveMarkKind } from "./notebook";

/**
 * Live annotations (K9, docs/NOTEBOOKS_K.md §7): while the student writes, each finished line is
 * checked and marked lightly (a tick, a circle with a 1–4 word hint, "units?", a margin note, or
 * a dashed "?" when neb isn't sure what it read). Silent by default; saved as they appear.
 */
export const ANNOTATION_LIMITS = {
  /** A line is finished once the pen has rested this long after its last stroke. */
  finishPauseMs: 1200,
  /** Below this recognition confidence a line is never marked wrong: it gets a "?" instead. */
  confidence: 0.75,
  /** Unresolved marks visible at once; more wait for the next pause. */
  visible: 6,
  /** Coach level: "next step?" after this long without writing. */
  stuckMs: 20_000,
  noteChars: 32,
  noteWords: 4,
  textChars: 500,
  /** Annotations sent to the server in one call. */
  syncBatch: 50,
} as const;

/** How much the tutor marks (§7.1), per notebook. */
export const MarkLevel = z.enum(["off", "quiet", "normal", "coach"]);
export type MarkLevel = z.infer<typeof MarkLevel>;
export const DEFAULT_MARK_LEVEL: MarkLevel = "normal";

export const MARK_LEVEL_LABELS: Record<MarkLevel, string> = {
  off: "Off",
  quiet: "Quiet: errors only",
  normal: "Normal: errors and ticks",
  coach: "Coach: also hints",
};

/** Whether a level shows a kind of mark. */
export function levelShows(level: MarkLevel, kind: LiveMarkKind): boolean {
  switch (level) {
    case "off":
      return false;
    case "quiet":
      return kind === "error" || kind === "missing" || kind === "unsure";
    case "normal":
      return kind !== "margin";
    case "coach":
      return true;
  }
}

export const MarkVerdict = z.enum(["correct", "incorrect", "unknown"]);
export type MarkVerdict = z.infer<typeof MarkVerdict>;

/** What decided a mark: a verifier, the rubric model (writing subjects), or Coach's nudge. */
export const MarkMethod = z.enum(["math", "chemistry", "code", "rubric", "coach", "reading"]);
export type MarkMethod = z.infer<typeof MarkMethod>;

/** The student removed a mark: it was wrong ("Not wrong", a correction) or just in the way. */
export const DismissedAs = z.enum(["not_wrong", "hidden"]);
export type DismissedAs = z.infer<typeof DismissedAs>;

const Millis = z.number().int().nonnegative();

/** One mark as the device keeps it (Dexie `annotations`), with its strokes on the page. */
export const Annotation = z.object({
  id: z.uuid(),
  pageId: z.uuid(),
  /** The line's lasting id (Notes Check's, when it has one). */
  lineId: z.uuid(),
  /** The line's strokes when it was marked: which line it is after edits (≥ half shared). */
  lineStrokeIds: z.array(z.string()).max(2000),
  markKind: LiveMarkKind,
  verdict: MarkVerdict,
  checkerMethod: MarkMethod,
  recognizedText: z.string().max(ANNOTATION_LIMITS.textChars),
  confidence: z.number().min(0).max(1).nullable(),
  strokeGroupId: z.uuid(),
  note: z.string().max(ANNOTATION_LIMITS.noteChars).nullable(),
  /** Where a tap opens its menu (its tick, note or "?"; never the circle round the line). */
  hitBox: BBox.nullable(),
  createdAt: Millis,
  resolvedAt: Millis.nullable(),
  dismissedAs: DismissedAs.nullable(),
  /** Hide-until-done: worked out, not shown until Alt+C or "check". */
  revealed: z.boolean(),
  /** "Why?" was asked about it (fixing it afterwards is `after_explanation`). */
  whyAsked: z.boolean(),
  /** What the line counted as once it was right (only for checker-verified lines). */
  evidence: Evidence.nullable(),
  /** The server has this version. */
  synced: z.boolean(),
});
export type Annotation = z.infer<typeof Annotation>;

/** A mark is live (on the page, unresolved, not dismissed). */
export const isOpen = (a: Pick<Annotation, "resolvedAt" | "dismissedAs">) =>
  a.resolvedAt === null && a.dismissedAs === null;

// ─── Sync (`annotations` table, RLS) ─────────────────────────────────────────────────────────

/**
 * An annotation as the server keeps it: no strokes or boxes (page content stays on the device,
 * decision 14). The recognised text goes only when the student lets neb keep their notes' text
 * (`notes_index`); "Not wrong" corrections feed the checker's and recognition's eval sets (§8).
 */
export const AnnotationUpsert = Annotation.pick({
  id: true,
  pageId: true,
  lineId: true,
  markKind: true,
  verdict: true,
  checkerMethod: true,
  confidence: true,
  strokeGroupId: true,
  note: true,
  createdAt: true,
  resolvedAt: true,
  dismissedAs: true,
  evidence: true,
}).extend({ recognizedText: Annotation.shape.recognizedText.nullable() });
export type AnnotationUpsert = z.infer<typeof AnnotationUpsert>;

export const AnnotationSyncRequest = z.object({
  annotations: z.array(AnnotationUpsert).min(1).max(ANNOTATION_LIMITS.syncBatch),
});
export type AnnotationSyncRequest = z.infer<typeof AnnotationSyncRequest>;

export const AnnotationSyncResult = z.object({ saved: z.number().int().nonnegative() });
export type AnnotationSyncResult = z.infer<typeof AnnotationSyncResult>;

export function toAnnotationUpsert(a: Annotation, keepText: boolean): AnnotationUpsert {
  return {
    id: a.id,
    pageId: a.pageId,
    lineId: a.lineId,
    markKind: a.markKind,
    verdict: a.verdict,
    checkerMethod: a.checkerMethod,
    recognizedText: keepText ? a.recognizedText : null,
    confidence: a.confidence,
    strokeGroupId: a.strokeGroupId,
    note: a.note,
    createdAt: a.createdAt,
    resolvedAt: a.resolvedAt,
    dismissedAs: a.dismissedAs,
    evidence: a.evidence,
  };
}

// ─── Deciding the mark for a finished line (§7.1–7.2) ────────────────────────────────────────

export type LiveCheck = {
  verdict: MarkVerdict;
  /** The verifier that decided, or null when none could. */
  checker: "math" | "chemistry" | "code" | null;
  reason: string;
};

export type LiveMarkInput = {
  check: LiveCheck;
  /** The line as read, and how sure recognition was (null: not read). */
  text: string;
  confidence: number | null;
  /** The line above it in the working, as read (for the hint). */
  previousText: string | null;
  /** Could a verifier check this kind of line at all (maths, physics, chemistry, code)? */
  checkable: boolean;
  level: MarkLevel;
  /** The line's open mark, if it has one. */
  existing: Pick<Annotation, "markKind" | "recognizedText"> | null;
};

export type LiveMarkPlan = {
  /** Take the line's open mark off the page. */
  remove: boolean;
  /** It came off because the line is right now ("resolved", not dismissed). */
  resolved: boolean;
  add: { kind: LiveMarkKind; note: string | null } | null;
};

const NOTHING: LiveMarkPlan = { remove: false, resolved: false, add: null };
const WRONG_KINDS = new Set<LiveMarkKind>(["error", "missing", "unsure"]);

/**
 * The mark a finished line gets, if any. A tick only after a verifier said so; a wrong line a
 * circle and a hint (never the corrected line); a line read with low confidence never an error
 * mark, a "?" instead; a fixed line's mark resolves (and gets its tick); the same mistake written
 * again keeps its one mark.
 */
export function planLiveMark(input: LiveMarkInput): LiveMarkPlan {
  const { check, level, existing } = input;
  if (level === "off") return NOTHING;
  const unsure = input.confidence !== null && input.confidence < ANNOTATION_LIMITS.confidence;
  const shown = (kind: LiveMarkKind, note: string | null) =>
    levelShows(level, kind) ? { kind, note } : null;

  if (check.verdict === "correct") {
    if (existing?.markKind === "tick") return NOTHING;
    const fixed = existing !== null && WRONG_KINDS.has(existing.markKind);
    return { remove: existing !== null, resolved: fixed, add: shown("tick", null) };
  }

  if (check.verdict === "incorrect") {
    if (unsure) {
      if (existing?.markKind === "unsure") return NOTHING;
      return { remove: existing !== null, resolved: false, add: shown("unsure", "?") };
    }
    const hint = markHint(check, input.text, input.previousText);
    if (
      existing &&
      existing.markKind === hint.kind &&
      sameReading(existing.recognizedText, input.text)
    ) {
      return NOTHING; // the same mistake again: still one mark
    }
    return { remove: existing !== null, resolved: false, add: shown(hint.kind, hint.note) };
  }

  // Nothing could say: a "?" only when it's the reading that's in doubt.
  if (unsure && input.checkable && !existing) return { ...NOTHING, add: shown("unsure", "?") };
  return NOTHING;
}

function sameReading(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  return norm(a) === norm(b);
}

/** The 1–4 word hint for a wrong line: where and what kind of problem, never the fix. */
export function markHint(
  check: Pick<LiveCheck, "checker" | "reason">,
  text: string,
  previousText: string | null,
): { kind: "error" | "missing"; note: string } {
  if (check.reason === "units") return { kind: "missing", note: "units?" };
  if (check.checker === "chemistry") return { kind: "missing", note: "not balanced" };
  if (check.checker === "code") return { kind: "error", note: "this line fails" };
  if (previousText && signSlip(previousText, text)) return { kind: "error", note: "sign?" };
  if (check.reason === "not_equal") return { kind: "error", note: "check arithmetic" };
  return { kind: "error", note: "check this step" };
}

const NUMBER = /\d+(?:\.\d+)?/g;
const numbers = (text: string) => (text.match(NUMBER) ?? []).map(Number);
/** Numbers standing alone as terms (not the coefficient of a letter or a bracket). */
const terms = (text: string) =>
  [...text.matchAll(/(\d+(?:\.\d+)?)(?!\s*[\p{L}(\d.])/gu)].map((m) => Number(m[1]));

/**
 * A sign slip: a number in the new line that's the sum (or difference) of two numbers of the
 * line before, where the other way round is what moving a term across gives. `3x + 7 = 19` →
 * `3x = 26` (19 + 7 instead of 19 − 7).
 */
export function signSlip(previousText: string, text: string): boolean {
  const sides = previousText.split("=");
  if (sides.length !== 2) return false;
  // The term moved across comes from one side, the number it's combined with from the other
  // (coefficients, like the 3 of 3x, aren't terms that move).
  const [left = [], right = []] = sides.map(terms);
  const before = [...left, ...right];
  const fresh = numbers(text).filter((n) => !before.includes(n));
  const pairs = [
    ...left.flatMap((b) => right.map((a) => [a, b] as const)),
    ...right.flatMap((b) => left.map((a) => [a, b] as const)),
  ];
  return fresh.some((n) =>
    pairs.some(([a, b]) => b !== 0 && (n === a + b || (a > b && n === a - b))),
  );
}

/**
 * Where on a wrong line the mistake is, as a fraction of its width (for circling just that part):
 * the side of an equation whose numbers changed into ones the line before doesn't have (the right
 * side when both did). Null when the line isn't two-sided like the one before.
 */
export function wrongPart(
  previousText: string | null,
  text: string,
): { from: number; to: number } | null {
  if (!previousText) return null;
  const sides = text.split("=");
  const before = previousText.split("=");
  if (sides.length !== 2 || before.length !== 2) return null;
  const [left = "", right = ""] = sides;
  const known = new Set(numbers(previousText));
  const changed = (side: string) => numbers(side).some((n) => !known.has(n));
  const total = text.length;
  if (total === 0) return null;
  const leftEnd = left.length / total;
  if (changed(right) || !changed(left)) return { from: (left.length + 1) / total, to: 1 };
  return { from: 0, to: leftEnd };
}

/** Evidence for a line once a verifier says it's right (§7.4). */
export function liveEvidence(mark: { hadMark: boolean; whyAsked: boolean }): Evidence {
  if (!mark.hadMark) return "independent";
  return mark.whyAsked ? "after_explanation" : "with_hint";
}

/** Strips a margin note to at most four words, no fixes in sight (the rubric's output). */
export function clampNote(note: string): string | null {
  const words = note
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, ANNOTATION_LIMITS.noteWords);
  const text = words.join(" ").slice(0, ANNOTATION_LIMITS.noteChars).trim();
  return text || null;
}

// ─── The rubric's margin notes (writing subjects, Coach level) ───────────────────────────────

export const LiveMarkRequest = z.object({
  /** The finished line, and up to three lines before it, as read. */
  line: z.string().trim().min(1).max(ANNOTATION_LIMITS.textChars),
  previous: z.array(z.string().max(ANNOTATION_LIMITS.textChars)).max(3),
  subject: z.enum(["biology", "history", "language", "other"]),
});
export type LiveMarkRequest = z.infer<typeof LiveMarkRequest>;

/** The model's answer: a 1–4 word note pointing at a problem, or null when there's none. */
export const LiveMarkResponse = z.object({
  note: z.string().max(60).nullable(),
});
export type LiveMarkResponse = z.infer<typeof LiveMarkResponse>;
