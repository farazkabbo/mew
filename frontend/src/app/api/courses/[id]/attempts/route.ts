import { AttemptRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { recordAttempt } from "@/server/attempts";
import { assertSameOrigin, handle, readJson, requireUserId } from "@/server/http";
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

    const progress = await recordAttempt(id, attempt);
    return NextResponse.json(progress);
  },
);
