import { DueCards, type ReviewQueue } from "@mew/shared";
import { NextResponse } from "next/server";

import { coursesApi } from "@/server/courses";
import { assertNotCrossSite, handle, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** Concepts due for review now, across all the student's courses (soonest first). */
export const GET = handle(async (request: Request) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { courseRead: RATE_RULES.courseRead });
  const { cards } = await coursesApi("/v1/learner/due", DueCards);
  const queue: ReviewQueue = {
    items: cards.map((c) => ({
      courseId: c.course_id,
      courseTitle: c.course_title,
      conceptId: c.concept_id,
      conceptTitle: c.concept_title,
      due: c.due_at,
      isNew: c.reps === 0,
    })),
  };
  return NextResponse.json(queue, { headers: { "Cache-Control": "no-store" } });
});
