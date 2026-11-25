import { PLAN_LIMITS, ScreenPlanRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { handle, readJson } from "@/server/http";
import { askerOf, rememberGroup, remainingHeaders, startQuestion } from "@/server/question-gate";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { planForScreen, planKey } from "@/server/screen-plan";

/** The JSON body: a sentence and up to 40 short control names. */
const MAX_BODY_BYTES = 8_000;

/**
 * The cursor modes' plan (docs/CURSOR_MODES.md), from the desktop app (device token): a SHOW ME
 * path or a DO IT action, from the student's words and the window's control names. Never a
 * screenshot. One plan is one of the learner's questions (finished when it's answered, refunded
 * when it fails); re-plans in the same lesson (`planId`) are free follow-ups, up to a few.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    screenPlan: RATE_RULES.screenPlan,
    screenPlanDaily: RATE_RULES.screenPlanDaily,
  });
  const body = await readJson(request, ScreenPlanRequest, MAX_BODY_BYTES);
  geminiEnv();
  const question = await startQuestion(
    askerOf(request, device.userId),
    body.planId ? { key: planKey(body.planId), cap: PLAN_LIMITS.replans } : undefined,
  );
  try {
    const reply = await question.run(() =>
      planForScreen(body, device.language, body.planId, request.signal),
    );
    await question.finish();
    // Its re-plans (same lesson) belong to this question.
    if (!question.followUp) {
      await rememberGroup(
        { key: planKey(reply.planId), cap: PLAN_LIMITS.replans },
        device.userId,
        question.id,
      );
    }
    return NextResponse.json(reply, {
      headers: { "Cache-Control": "no-store", ...remainingHeaders(question) },
    });
  } catch (error) {
    await question.refund();
    throw error;
  }
});
