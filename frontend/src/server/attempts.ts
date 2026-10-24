import "server-only";

import { type AttemptRequest, type ConceptProgress, LearnerData } from "@mew/shared";
import { z } from "zod";

import { coursesApi } from "./courses";
import { HttpError } from "./http-error";
import { progressOf, review } from "./learner";

/**
 * Records one answer for a concept (with how it came about), reschedules the concept's review
 * with FSRS, and returns its new progress: practice, quiz, and Notes Check outcomes alike (M8).
 */
export async function recordAttempt(
  courseId: string,
  attempt: AttemptRequest,
  now: Date = new Date(),
): Promise<ConceptProgress> {
  const data = await coursesApi(`/v1/courses/${courseId}/learner`, LearnerData);
  const previous = data.cards.find((c) => c.concept_id === attempt.conceptId);
  const card = review(previous?.fsrs_state ?? null, attempt, now);
  await coursesApi(`/v1/courses/${courseId}/attempts`, z.undefined(), {
    method: "POST",
    body: {
      concept_id: attempt.conceptId,
      correct: attempt.correct,
      evidence: attempt.evidence,
      source: attempt.source,
      card,
    },
  });

  // The concept's progress including this answer (without reading it all back).
  const updated: LearnerData = {
    attempts: [
      ...data.attempts,
      {
        concept_id: attempt.conceptId,
        correct: attempt.correct,
        evidence: attempt.evidence,
        source: attempt.source,
        created_at: now.toISOString(),
      },
    ],
    cards: [
      ...data.cards.filter((c) => c.concept_id !== attempt.conceptId),
      { concept_id: attempt.conceptId, fsrs_state: card, due_at: card.due },
    ],
  };
  const progress = progressOf(updated, now).find((p) => p.conceptId === attempt.conceptId);
  if (!progress) throw new HttpError(500, "Couldn't record that answer");
  return progress;
}
