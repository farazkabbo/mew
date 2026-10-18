import { Lesson } from "@mew/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { coursesApi } from "@/server/courses";
import { assertNotCrossSite, handle, HttpError, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

type Context = { params: Promise<{ id: string; conceptId: string }> };

/** A concept's lesson: generated from the course material the first time, then cached. */
export const GET = handle(async (request: Request, context: Context) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { lesson: RATE_RULES.lesson, lessonDaily: RATE_RULES.lessonDaily });
  const params = z.object({ id: z.uuid(), conceptId: z.uuid() }).safeParse(await context.params);
  if (!params.success) throw new HttpError(404, "Lesson not found");
  const { id, conceptId } = params.data;
  const lesson = await coursesApi(`/v1/courses/${id}/concepts/${conceptId}/lesson`, Lesson);
  return NextResponse.json(lesson, { headers: { "Cache-Control": "no-store" } });
});
