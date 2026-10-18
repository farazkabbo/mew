import { CourseDetail, CourseUpdate } from "@mew/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { coursesApi } from "@/server/courses";
import {
  assertNotCrossSite,
  assertSameOrigin,
  handle,
  HttpError,
  readJson,
  requireUserId,
} from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

type Context = { params: Promise<{ id: string }> };

export async function courseId(context: Context): Promise<string> {
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) throw new HttpError(404, "Course not found");
  return id.data;
}

/** A course with its sources, concepts (in order) and prerequisite edges. */
export const GET = handle(async (request: Request, context: Context) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { courseRead: RATE_RULES.courseRead });
  const detail = await coursesApi(`/v1/courses/${await courseId(context)}`, CourseDetail);
  return NextResponse.json(detail, { headers: { "Cache-Control": "no-store" } });
});

/** Title, exam date, or confirming the scope review ("ready"). */
export const PATCH = handle(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { courseRead: RATE_RULES.courseRead });
  const body = await readJson(request, CourseUpdate, 2_000);
  const detail = await coursesApi(`/v1/courses/${await courseId(context)}`, CourseDetail, {
    method: "PATCH",
    body,
  });
  return NextResponse.json(detail);
});

export const DELETE = handle(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { courseRead: RATE_RULES.courseRead });
  await coursesApi(`/v1/courses/${await courseId(context)}`, z.undefined(), { method: "DELETE" });
  return new NextResponse(null, { status: 204 });
});
