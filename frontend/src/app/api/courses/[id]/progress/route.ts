import { type CourseProgress, LearnerData } from "@mew/shared";
import { NextResponse } from "next/server";

import { coursesApi } from "@/server/courses";
import { assertNotCrossSite, handle, requireUserId } from "@/server/http";
import { progressOf } from "@/server/learner";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

import { courseId } from "../route";

/** The student's progress on each concept they've started: status and next review. */
export const GET = handle(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    assertNotCrossSite(request);
    const userId = await requireUserId();
    enforceRateLimit(userId, { courseRead: RATE_RULES.courseRead });
    const data = await coursesApi(`/v1/courses/${await courseId(context)}/learner`, LearnerData);
    const progress: CourseProgress = { concepts: progressOf(data, new Date()) };
    return NextResponse.json(progress, { headers: { "Cache-Control": "no-store" } });
  },
);
