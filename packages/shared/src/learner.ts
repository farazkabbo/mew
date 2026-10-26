import { z } from "zod";

/**
 * Learner model (M8): attempts with evidence, concept status, the review queue and exam
 * planning. Scheduling itself (FSRS) runs on the server; everything here is pure.
 * Mirrors backend/src/mew_api/learner/models.py.
 */

/** How a correct answer came about. Only `independent` answers count as knowing a concept. */
export const Evidence = z.enum(["independent", "with_hint", "after_explanation"]);
export type Evidence = z.infer<typeof Evidence>;

/** Where an answer came from; `your_turn` is Show-then-You's practice problem (K6). */
export const AttemptSource = z.enum([
  "practice",
  "quiz",
  "notes_check",
  "your_turn",
  /** A saved moment's check question (K8). */
  "moment_check",
]);
export type AttemptSource = z.infer<typeof AttemptSource>;

export const ConceptStatus = z.enum([
  "not_started",
  "explored",
  "practised_with_hint",
  "checked",
  "revisit",
]);
export type ConceptStatus = z.infer<typeof ConceptStatus>;

export const CONCEPT_STATUS_LABELS: Record<ConceptStatus, string> = {
  not_started: "Not started",
  explored: "Explored",
  practised_with_hint: "Practised with hint",
  checked: "Checked",
  revisit: "Revisit",
};

const Timestamp = z.iso.datetime({ offset: true });

/** A ts-fsrs card as stored in `review_cards.fsrs_state` (dates as ISO strings). */
export const FsrsCard = z
  .object({
    due: Timestamp,
    stability: z.number().min(0).max(36_500),
    difficulty: z.number().min(0).max(10),
    elapsed_days: z.number().min(0).max(36_500),
    scheduled_days: z.number().min(0).max(36_500),
    learning_steps: z.number().int().min(0).max(100),
    reps: z.number().int().min(0).max(100_000),
    lapses: z.number().int().min(0).max(100_000),
    state: z.number().int().min(0).max(3),
    last_review: Timestamp.nullable(),
  })
  .strict();
export type FsrsCard = z.infer<typeof FsrsCard>;

// ─── What the API service stores ───────────────────────────────────────────────────────────

export const AttemptRecord = z.object({
  concept_id: z.uuid(),
  correct: z.boolean(),
  evidence: Evidence,
  source: AttemptSource,
  created_at: Timestamp,
});
export type AttemptRecord = z.infer<typeof AttemptRecord>;

export const CardRecord = z.object({
  concept_id: z.uuid(),
  fsrs_state: FsrsCard,
  due_at: Timestamp,
});
export type CardRecord = z.infer<typeof CardRecord>;

/** A course's attempts (oldest first) and review cards. */
export const LearnerData = z.object({
  attempts: z.array(AttemptRecord),
  cards: z.array(CardRecord),
});
export type LearnerData = z.infer<typeof LearnerData>;

export const DueCard = z.object({
  course_id: z.uuid(),
  course_title: z.string(),
  concept_id: z.uuid(),
  concept_title: z.string(),
  due_at: Timestamp,
  reps: z.number().int(),
});
export const DueCards = z.object({ cards: z.array(DueCard) });

// ─── What the web app sees ─────────────────────────────────────────────────────────────────

/** Records one answer to a practice or quiz question. */
export const AttemptRequest = z
  .object({
    conceptId: z.uuid(),
    correct: z.boolean(),
    evidence: Evidence,
    source: AttemptSource,
  })
  .strict();
export type AttemptRequest = z.infer<typeof AttemptRequest>;

export const ConceptProgress = z.object({
  conceptId: z.uuid(),
  status: ConceptStatus,
  /** When FSRS wants the concept practised again (null until the student starts it). */
  due: Timestamp.nullable(),
  attempts: z.number().int(),
  /** Correct answers given without help. */
  independent: z.number().int(),
  lastAttemptAt: Timestamp.nullable(),
});
export type ConceptProgress = z.infer<typeof ConceptProgress>;

/** Progress on the concepts the student has started (the others are "not started"). */
export const CourseProgress = z.object({ concepts: z.array(ConceptProgress) });
export type CourseProgress = z.infer<typeof CourseProgress>;

export const ReviewItem = z.object({
  courseId: z.uuid(),
  courseTitle: z.string(),
  conceptId: z.uuid(),
  conceptTitle: z.string(),
  due: Timestamp,
  /** Opened but never practised. */
  isNew: z.boolean(),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

export const ReviewQueue = z.object({ items: z.array(ReviewItem) });
export type ReviewQueue = z.infer<typeof ReviewQueue>;

// ─── Status ────────────────────────────────────────────────────────────────────────────────

type AttemptLike = Pick<AttemptRecord, "correct" | "evidence">;

/** A correct answer that wasn't simply shown first. */
export function isSuccess(attempt: AttemptLike): boolean {
  return attempt.correct && attempt.evidence !== "after_explanation";
}

/**
 * A concept's status from its attempts (oldest first) and review card. The most recent answer
 * decides: "checked" needs the last one to be correct without help; a wrong answer after an
 * earlier success, or a review that has come due, means "revisit".
 */
export function conceptStatus({
  attempts,
  explored,
  due,
  now,
}: {
  attempts: readonly AttemptLike[];
  explored: boolean;
  due: Date | null;
  now: Date;
}): ConceptStatus {
  const last = attempts.at(-1);
  if (!last) return explored ? "explored" : "not_started";
  if (!attempts.some(isSuccess)) return "explored";
  if (!isSuccess(last) || (due !== null && due.getTime() <= now.getTime())) return "revisit";
  return last.evidence === "independent" ? "checked" : "practised_with_hint";
}

/** Progress for every concept of a course, filling in the ones never started. */
export function progressFor(
  conceptIds: readonly string[],
  known: readonly ConceptProgress[],
): Map<string, ConceptProgress> {
  const byId = new Map(known.map((p) => [p.conceptId, p]));
  return new Map(
    conceptIds.map((id) => [
      id,
      byId.get(id) ?? {
        conceptId: id,
        status: "not_started" as const,
        due: null,
        attempts: 0,
        independent: 0,
        lastAttemptAt: null,
      },
    ]),
  );
}

// ─── Quiz order ────────────────────────────────────────────────────────────────────────────

const QUEUE_RANK: Record<ConceptStatus, number> = {
  revisit: 0,
  practised_with_hint: 1,
  explored: 2,
  not_started: 3,
  checked: 4,
};

/**
 * The order to quiz concepts in: today's planned concepts first (with an exam date), then what
 * needs revisiting (most overdue first), then started-but-unchecked, then new concepts in course
 * order (prerequisites come first in it), and finally checked ones (soonest due first).
 */
export function quizQueue(
  orderedIds: readonly string[],
  progress: ReadonlyMap<string, ConceptProgress>,
  focus: readonly string[] = [],
): string[] {
  const position = new Map(orderedIds.map((id, i) => [id, i]));
  const focused = new Set(focus);
  const dueTime = (id: string) => {
    const due = progress.get(id)?.due;
    return due ? Date.parse(due) : Infinity;
  };
  const rank = (id: string) => QUEUE_RANK[progress.get(id)?.status ?? "not_started"];
  return [...orderedIds].sort((a, b) => {
    const focusDiff = Number(focused.has(b)) - Number(focused.has(a));
    if (focusDiff !== 0) return focusDiff;
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    if (rank(a) === QUEUE_RANK.revisit || rank(a) === QUEUE_RANK.checked) {
      const dueDiff = dueTime(a) - dueTime(b);
      if (dueDiff !== 0) return dueDiff;
    }
    return (position.get(a) ?? 0) - (position.get(b) ?? 0);
  });
}

// ─── Exam planning ─────────────────────────────────────────────────────────────────────────

export type StudyDay = {
  /** YYYY-MM-DD */
  date: string;
  /** Concepts to learn or work on (not yet checked, or to revisit). */
  learn: string[];
  /** Checked concepts whose review falls due before the exam. */
  review: string[];
  /** The day before the exam: a last pass over everything. */
  finalReview: boolean;
};

export type ExamPlan = {
  /** Whole days from today to the exam (0 = today, negative = passed). */
  daysLeft: number;
  days: StudyDay[];
};

const DAY_MS = 86_400_000;
const WORK: ReadonlySet<ConceptStatus> = new Set([
  "not_started",
  "explored",
  "practised_with_hint",
]);

/** Days between two calendar dates (YYYY-MM-DD), ignoring time zones and DST. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The local calendar date of a moment, as YYYY-MM-DD. */
export function localDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * Spreads the work left before an exam over the days remaining (brief §9: unchecked and
 * "revisit" concepts first). Concepts to revisit lead, then unchecked ones in course order;
 * checked concepts come back on the day their review falls due if that's before the exam; and
 * with three or more days left, the day before the exam is kept for a final review.
 */
export function planExam({
  orderedIds,
  progress,
  examDate,
  today,
}: {
  orderedIds: readonly string[];
  progress: ReadonlyMap<string, ConceptProgress>;
  examDate: string;
  today: string;
}): ExamPlan {
  const daysLeft = daysBetween(today, examDate);
  if (daysLeft < 0) return { daysLeft, days: [] };

  const studyDays = Math.max(1, daysLeft);
  const days: StudyDay[] = Array.from({ length: studyDays }, (_, i) => ({
    date: addDays(today, i),
    learn: [],
    review: [],
    finalReview: false,
  }));
  const reserveFinal = studyDays >= 3;
  const learningDays = reserveFinal ? studyDays - 1 : studyDays;
  const final = days.at(-1);
  if (reserveFinal && final) final.finalReview = true;

  const status = (id: string) => progress.get(id)?.status ?? "not_started";
  const work = [
    ...orderedIds.filter((id) => status(id) === "revisit"),
    ...orderedIds.filter((id) => WORK.has(status(id))),
  ];
  const perDay = Math.ceil(work.length / learningDays);
  work.forEach((id, i) => days[Math.floor(i / perDay)]?.learn.push(id));

  for (const id of orderedIds) {
    const due = progress.get(id)?.due;
    if (status(id) !== "checked" || !due) continue;
    const offset = daysBetween(today, localDate(new Date(due)));
    if (offset >= studyDays) continue; // not due before the exam
    days[Math.max(0, offset)]?.review.push(id);
  }
  return { daysLeft, days };
}
