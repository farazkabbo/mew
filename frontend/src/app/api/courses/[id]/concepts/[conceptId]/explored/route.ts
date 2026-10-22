import { NextResponse } from "next/server";
import { z } from "zod";

import { coursesApi } from "@/server/courses";
import { assertSameOrigin, handle, HttpError, requireUserId } from "@/server/http";
import { newCard } from "@/server/learner";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

type Context = { params: Promise<{ id: string; conceptId: string }> };

/** The student opened a concept's lesson: it counts as explored and joins the review queue. */
export const POST = handle(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { attempt: RATE_RULES.attempt, attemptDaily: RATE_RULES.attemptDaily });
  const params = z.object({ id: z.uuid(), conceptId: z.uuid() }).safeParse(await context.params);
  if (!params.success) throw new HttpError(404, "Concept not found");
  const { id, conceptId } = params.data;
  await coursesApi(`/v1/courses/${id}/explored`, z.undefined(), {
    method: "POST",
    body: { concept_id: conceptId, card: newCard(new Date()) },
  });
  return new NextResponse(null, { status: 204 });
});
