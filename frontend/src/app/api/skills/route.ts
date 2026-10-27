import { SkillsView } from "@mew/shared";
import { NextResponse } from "next/server";

import { assertNotCrossSite, handle, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

/**
 * The student's skills from coach mode (S5): when each is due for a re-check and how the last
 * go went, for the review page and the desktop app's reminders. Read with their own session.
 */
export const GET = handle(async (request: Request) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { courseRead: RATE_RULES.courseRead });
  const skills = await userApi("/v1/skills", SkillsView);
  return NextResponse.json(skills, { headers: { "Cache-Control": "no-store" } });
});
