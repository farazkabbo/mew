import "server-only";

import {
  type AttemptRecord,
  type ConceptProgress,
  conceptStatus,
  type Evidence,
  FsrsCard,
  isSuccess,
  type LearnerData,
} from "@mew/shared";
// Server-only on purpose: ts-fsrs 5 adds deprecated helpers to Date.prototype when imported.
import { type Card, createEmptyCard, fsrs, type Grade, Rating } from "ts-fsrs";

/**
 * Concepts aren't flashcards: no minute-level learning steps (a correct answer isn't asked again
 * ten minutes later), and no fuzz, so schedules are reproducible. Wrong → tomorrow; with a
 * hint → in two days; on their own → in three, growing from there.
 */
const scheduler = fsrs({
  enable_fuzz: false,
  enable_short_term: false,
  learning_steps: [],
  relearning_steps: [],
});

/**
 * Brief §9: mastery only grows meaningfully from independent answers. A correct answer with a
 * hint grows it a little ("Hard"); one given after being shown how counts as not known yet.
 */
export function ratingFor(attempt: { correct: boolean; evidence: Evidence }): Grade {
  if (!isSuccess(attempt)) return Rating.Again;
  return attempt.evidence === "independent" ? Rating.Good : Rating.Hard;
}

export function newCard(now: Date): FsrsCard {
  return toStored(createEmptyCard(now));
}

/** The concept's card after one more answer. */
export function review(
  card: FsrsCard | null,
  attempt: { correct: boolean; evidence: Evidence },
  now: Date,
): FsrsCard {
  const current: Card = card ? fromStored(card) : createEmptyCard(now);
  return toStored(scheduler.next(current, now, ratingFor(attempt)).card);
}

/** Progress on each concept the student has started, from its attempts and card. */
export function progressOf(data: LearnerData, now: Date): ConceptProgress[] {
  const attempts = new Map<string, AttemptRecord[]>();
  for (const attempt of data.attempts) {
    const list = attempts.get(attempt.concept_id) ?? [];
    list.push(attempt);
    attempts.set(attempt.concept_id, list);
  }
  const cards = new Map(data.cards.map((c) => [c.concept_id, c]));
  const ids = new Set([...attempts.keys(), ...cards.keys()]);
  return [...ids].map((conceptId) => {
    const list = attempts.get(conceptId) ?? [];
    const due = cards.get(conceptId)?.due_at ?? null;
    return {
      conceptId,
      status: conceptStatus({
        attempts: list,
        explored: cards.has(conceptId),
        due: due ? new Date(due) : null,
        now,
      }),
      due,
      attempts: list.length,
      independent: list.filter((a) => a.correct && a.evidence === "independent").length,
      lastAttemptAt: list.at(-1)?.created_at ?? null,
    };
  });
}

function toStored(card: Card): FsrsCard {
  return FsrsCard.parse({
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review ? card.last_review.toISOString() : null,
  });
}

function fromStored(card: FsrsCard): Card {
  const { last_review: lastReview, ...rest } = card;
  return {
    ...rest,
    due: new Date(card.due),
    ...(lastReview && { last_review: new Date(lastReview) }),
  };
}
