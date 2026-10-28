import { z } from "zod";

import { ResolvedDestination } from "./destinations";
import { Evidence } from "./learner";
import { Subject } from "./tutor";

/**
 * Moments (K8, docs/NOTEBOOKS_K.md §4.6–4.7): every saved screen entry is a moment. It's filed
 * by what the student studies (not whichever notebook is open), it can be revisited at the exact
 * spot, and it brings a check question back later, as a review card.
 */
export const MOMENT_LIMITS = {
  promptChars: 300,
  answerChars: 300,
  choiceChars: 120,
  choices: 4,
  hints: 5,
  noteChars: 80,
  alternatives: 3,
  /** New moment cards a day; the rest wait in a queue. */
  newPerDay: 15,
  /** Moments about the same concept within this many days share one card. */
  mergeDays: 7,
  quickCheck: { min: 3, max: 5 },
  /** An answer, as typed or said. */
  replyChars: 500,
} as const;

const L = MOMENT_LIMITS;
const Text = (max: number) => z.string().trim().min(1).max(max);

// ─── The check question (§4.7) ───────────────────────────────────────────────────────────────

/**
 * One check question per moment, from the same call that answered it. It tests the idea, not
 * recall of the screen. Its key stays on the server: the device never sees it.
 */
export const CheckQuestion = z.object({
  kind: z.enum(["short", "mcq", "work"]),
  prompt: Text(L.promptChars),
  /** The options, for "mcq" (the key is one of them); [] otherwise. */
  choices: z.array(Text(L.choiceChars)).max(L.choices),
  answerKey: Text(L.answerChars),
  /**
   * For maths: the key and the question as LaTeX ("Solve 2x = 6" → "2x = 6", "x = 3"), so the key
   * is verified before it's stored. Null when the answer is words.
   */
  answerLatex: z.string().trim().max(L.answerChars).nullable(),
  problemLatex: z.string().trim().max(L.promptChars).nullable(),
});
export type CheckQuestion = z.infer<typeof CheckQuestion>;

/** What an entry keeps besides its explanation (attached by the web server, never the device). */
export const MomentMeta = z.object({
  subject: Subject.nullable(),
  /** Verified (or words); null when there was none or its key failed verification. */
  checkQuestion: CheckQuestion.nullable(),
});
export type MomentMeta = z.infer<typeof MomentMeta>;

// ─── Filing (§4.6) ───────────────────────────────────────────────────────────────────────────

export const FilingMethod = z.enum([
  "spoken",
  "source_memory",
  "content_match",
  "subject_match",
  "sticky",
  "unsorted",
]);
export type FilingMethod = z.infer<typeof FilingMethod>;

/**
 * What the server's filing adds to a `destination` stream event: why it went there (shown after
 * the place), other places to tap, and a notebook to start (Unsorted's "+ New notebook: Biology").
 */
export const FilingNote = z.object({
  method: FilingMethod,
  /** `matched "projectile motion"`, or "Where should this go?" */
  note: z.string().max(L.noteChars).nullable(),
  alternatives: z.array(ResolvedDestination).max(L.alternatives),
  newNotebook: z.string().trim().min(1).max(80).nullable(),
});
export type FilingNote = z.infer<typeof FilingNote>;

/**
 * The student's Unsorted notebook (§4.6 step 6): a system notebook that can't be deleted. Its id
 * is derived from the user id, so the server can file into it before any device has made it, and
 * two devices never make two (a version-8 UUID from four FNV-1a hashes of the id).
 */
export function unsortedNodeId(userId: string): string {
  const words = [0x811c9dc5, 0x01000193, 0x5bd1e995, 0x27d4eb2f].map((seed) => {
    let hash = seed >>> 0;
    for (const ch of `unsorted:${userId}`) {
      hash ^= ch.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  });
  const hex = words.join("").split("");
  hex[12] = "8"; // version 8: a custom UUID
  hex[16] = "89ab"[parseInt(hex[16] ?? "0", 16) & 3] ?? "8"; // RFC 4122 variant
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export const UNSORTED_TITLE = "Unsorted";

/** Unsorted's "File these" (§4.6): ask for a place for each waiting moment. */
export const MomentSuggestionsRequest = z.object({
  clipIds: z.array(z.uuid()).min(1).max(30),
});
export type MomentSuggestionsRequest = z.infer<typeof MomentSuggestionsRequest>;

/** A place for a waiting moment, or none (nothing fits well enough to suggest one). */
export const MomentSuggestion = z.object({
  clipId: z.uuid(),
  nodeId: z.uuid().nullish(),
  path: z.array(z.string().min(1).max(200)).min(1).max(3).nullish(),
  method: FilingMethod.exclude(["spoken", "unsorted"]).nullish(),
  matched: z.string().max(80).nullish(),
});
export type MomentSuggestion = z.infer<typeof MomentSuggestion>;

export const MomentSuggestions = z.object({ suggestions: z.array(MomentSuggestion).max(30) });
export type MomentSuggestions = z.infer<typeof MomentSuggestions>;

/** `POST /api/moments/[clipId]/move`: a moment filed from the notebook (moved, or accepted). */
export const MomentMove = z.object({ nodeId: z.uuid() });
export type MomentMove = z.infer<typeof MomentMove>;

// ─── "Quiz me on what I saved today" (§4.5) ──────────────────────────────────────────────────

export type SavedQuizFilter = { since: "today" | "week" | null; place: string | null };

/**
 * "Quiz me on what I saved today" (or "…this week", "…in Physics"): the Quick check it asks for,
 * or null when the words are something else.
 */
export function savedQuizRequest(utterance: string): SavedQuizFilter | null {
  const text = utterance
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match =
    /\b(?:quiz|test|check) me on (?:what|the things|everything|stuff) i(?:'ve| have)? saved\b(.*)$/.exec(
      text,
    );
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  const since = /\btoday\b/.test(rest)
    ? "today"
    : /\b(?:this|last) week\b/.test(rest)
      ? "week"
      : null;
  const place = /\b(?:in|from|for) (?:my )?(.+?)(?: notebook)?(?: today| this week)?$/.exec(
    rest,
  )?.[1];
  return { since, place: place?.trim() || null };
}

// ─── Checks to answer (§4.7) ─────────────────────────────────────────────────────────────────

/** A check due for the student, as the review and Quick check show it (no key). */
export const MomentCheckView = z.object({
  id: z.uuid(),
  /** The saved moment it came from; null for a "quiz me on this" card (S6: nothing was saved). */
  clipId: z.uuid().nullable(),
  /** A saved moment's check (K8), or a question from "quiz me on this" on screen (S6). */
  origin: z.enum(["moment", "screen_quiz"]).default("moment"),
  /** S6: the window it was about ("Lecture 5 - YouTube"), for "From your screen: …". */
  sourceTitle: z.string().nullable().default(null),
  /** Other moments about the same concept that week, merged into this card. */
  mergedClipIds: z.array(z.uuid()).max(20).default([]),
  nodeId: z.uuid().nullable(),
  prompt: z.string(),
  kind: CheckQuestion.shape.kind,
  choices: z.array(z.string()),
  conceptHints: z.array(z.string()),
  /** Never answered yet. */
  isNew: z.boolean(),
  dueAt: z.iso.datetime({ offset: true }),
  /** When its moment was saved ("From your moment on Tue"). */
  createdAt: z.iso.datetime({ offset: true }),
});
export type MomentCheckView = z.infer<typeof MomentCheckView>;

export const MomentChecksDue = z.object({ checks: z.array(MomentCheckView).max(200) });
export type MomentChecksDue = z.infer<typeof MomentChecksDue>;

/**
 * `GET /api/moments/stayed` (NEB_APP_UI §6.4): what stayed, per notebook (local mode: per node;
 * `stayedByNotebook` adds them up the tree either way).
 */
export const MomentStayed = z.object({
  notebooks: z
    .array(
      z.object({
        notebookId: z.uuid(),
        stayedCount: z.number().int().min(0),
        stayedWeek: z.number().int().min(0),
      }),
    )
    .max(2000),
});
export type MomentStayed = z.infer<typeof MomentStayed>;

/** `POST /api/moments/checks/[id]/answer`: the student's answer, and whether they had help. */
export const MomentCheckAnswer = z.object({
  answer: z.string().trim().min(1).max(L.replyChars),
  /** Looked at the moment (or its replay) before answering. */
  peeked: z.boolean(),
  /** Asked for a hint. */
  hinted: z.boolean(),
  /** "I don't know yet" (NEB_APP_UI §5.5): not graded, it comes back sooner. */
  dontKnow: z.boolean().optional(),
});
export type MomentCheckAnswer = z.infer<typeof MomentCheckAnswer>;

export const MomentCheckResult = z.object({
  correct: z.boolean(),
  /** What it counted as: only correct with no peek or hint is `independent` (mastery). */
  evidence: Evidence.nullable(),
  /** Shown after answering (retrieval first, then the key and a short explanation). */
  answerKey: z.string(),
  feedback: z.string().max(400),
  nextDue: z.iso.datetime({ offset: true }),
  /** Right, alone, a day or more after it was saved (§6.4: "that one stayed"). */
  stayed: z.boolean().default(false),
});
export type MomentCheckResult = z.infer<typeof MomentCheckResult>;

/** What an answer counts as (§4.7): correct alone → independent; with a peek or hint → with_hint. */
export function checkEvidence(answer: {
  correct: boolean;
  peeked: boolean;
  hinted: boolean;
}): Evidence | null {
  if (!answer.correct) return null; // logged as an attempt; the card comes back sooner
  return answer.peeked || answer.hinted ? "with_hint" : "independent";
}

/** A day: a check answered right alone at least this long after it was saved has stayed. */
export const STAYED_AFTER_MS = 86_400_000;

/** Whether an answer counts as "stayed" (NEB_APP_UI §6.4, decision U10). */
export function stayedFor(answer: {
  correct: boolean;
  peeked: boolean;
  hinted: boolean;
  savedAt: number;
  now: number;
}): boolean {
  return (
    answer.correct &&
    !answer.peeked &&
    !answer.hinted &&
    answer.now - answer.savedAt >= STAYED_AFTER_MS
  );
}

/**
 * A Quick check (§4.7): 3–5 of the due checks, mostly from recent moments (the newest first,
 * then the most overdue), filtered by when the moment was saved and where it was filed.
 */
export function pickQuickCheck(
  checks: readonly MomentCheckView[],
  options: {
    now: number;
    since?: "today" | "week" | null;
    nodeIds?: ReadonlySet<string> | null;
    /** An exam is close (`examSoon`): the Quick check stays short, the exam's reviews first. */
    examSoon?: boolean;
  },
): MomentCheckView[] {
  const startOfDay = new Date(options.now);
  startOfDay.setHours(0, 0, 0, 0);
  const from =
    options.since === "today"
      ? startOfDay.getTime()
      : options.since === "week"
        ? options.now - 7 * 86_400_000
        : -Infinity;
  const nodes = options.nodeIds ?? null;
  const fits = checks.filter(
    (c) =>
      Date.parse(c.createdAt) >= from &&
      (nodes === null || (c.nodeId !== null && nodes.has(c.nodeId))),
  );
  // "Quiz me on what I saved today" asks about those moments even before they're due.
  const asked = options.since ? fits : fits.filter((c) => Date.parse(c.dueAt) <= options.now);
  const recent = [...asked].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const max = options.examSoon ? L.quickCheck.min : L.quickCheck.max;
  const half = Math.ceil(max / 2);
  const newest = recent.slice(0, half);
  const overdue = recent
    .slice(half)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
    .slice(0, max - newest.length);
  return [...newest, ...overdue];
}

/** Days before an exam when its course's reviews outrank saved moments' checks (§4.7). */
export const EXAM_PRIORITY_DAYS = 14;

/**
 * The nearest exam still to come within two weeks ("exam dates still take priority", §4.7), or
 * null. Courses' `exam_date` are ISO dates; today counts (0 days left).
 */
export function examSoon(
  courses: readonly { id: string; title: string; exam_date?: string | null | undefined }[],
  now: number,
): { courseId: string; title: string; daysLeft: number } | null {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  let best: { courseId: string; title: string; daysLeft: number } | null = null;
  for (const course of courses) {
    if (!course.exam_date) continue;
    const exam = new Date(`${course.exam_date.slice(0, 10)}T00:00:00`);
    const daysLeft = Math.round((exam.getTime() - today.getTime()) / 86_400_000);
    if (Number.isNaN(daysLeft) || daysLeft < 0 || daysLeft > EXAM_PRIORITY_DAYS) continue;
    if (!best || daysLeft < best.daysLeft)
      best = { courseId: course.id, title: course.title, daysLeft };
  }
  return best;
}
