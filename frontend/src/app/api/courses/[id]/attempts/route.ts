import { AttemptRequest, LearnerData } from "@mew/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { coursesApi } from "@/server/courses";
import { assertSameOrigin, handle, HttpError, readJson, requireUserId } from "@/server/http";
import { progressOf, review } from "@/server/learner";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

import { courseId } from "../route";

/**
 * Records one answer to a practice or quiz question (with how it came about), reschedules the
 * concept's review with FSRS, and returns the concept's new progress.
 */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);
    const userId = await requireUserId();
    enforceRateLimit(userId, {
      attempt: RATE_RULES.attempt,
      attemptDaily: RATE_RULES.attemptDaily,
    });
    const attempt = await readJson(request, AttemptRequest, 1_000);
    const id = await courseId(context);

    const data = await coursesApi(`/v1/courses/${id}/learner`, LearnerData);
    const now = new Date();
    const previous = data.cards.find((c) => c.concept_id === attempt.conceptId);
    const card = review(previous?.fsrs_state ?? null, attempt, now);
    await coursesApi(`/v1/courses/${id}/attempts`, z.undefined(), {
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
    return NextResponse.json(progress);
  },
);
