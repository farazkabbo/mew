import { ConceptReview, CourseDetail } from "@mew/shared";
import { NextResponse } from "next/server";

import { coursesApi } from "@/server/courses";
import { assertSameOrigin, handle, readJson, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

import { courseId } from "../route";

/** The scope review: merge, remove (leave out of `order`), reorder and rename concepts. */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);
    const userId = await requireUserId();
    enforceRateLimit(userId, { courseRead: RATE_RULES.courseRead });
    const body = await readJson(request, ConceptReview, 20_000);
    const detail = await coursesApi(`/v1/courses/${await courseId(context)}/review`, CourseDetail, {
      method: "POST",
      body,
    });
    return NextResponse.json(detail);
  },
);
