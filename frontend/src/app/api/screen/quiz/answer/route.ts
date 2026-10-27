import { ScreenQuizAnswerRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { deviceToken, requireDevice } from "@/server/device-auth";
import { handle, readJson } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { answerScreenQuiz, screenQuizDeps } from "@/server/screen-quiz";

/**
 * An answer to a "quiz me on this" question (S6), typed, said or picked on screen (device token).
 * Graded here with the key from the API; the reply says whether it's right, and the answer if not.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    quizGrade: RATE_RULES.quizGrade,
    quizGradeDaily: RATE_RULES.quizGradeDaily,
  });
  const body = await readJson(request, ScreenQuizAnswerRequest, 4_000);
  const reply = await answerScreenQuiz(body, screenQuizDeps(deviceToken(request)));
  return NextResponse.json(reply, { headers: { "Cache-Control": "no-store" } });
});
