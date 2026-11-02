import { ScreenQuizRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { deviceToken, requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { handle, readJson } from "@/server/http";
import { assertJpeg } from "@/server/jpeg";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { makeScreenQuiz, screenQuizDeps } from "@/server/screen-quiz";

/** The JSON body: a base64 JPEG (~1 MB at most) plus the window's title. */
const MAX_BODY_BYTES = 1_500_000;

/**
 * "Quiz me on this" (Screen Coach S6), from the desktop app (device token): 1–3 questions about
 * the screen, each kept as a recall card. The reply has the questions without their keys. The
 * screenshot was captured and redacted on the device; it is forwarded to the model and dropped
 * with the request, never stored or logged.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    screenQuiz: RATE_RULES.screenQuiz,
    screenQuizDaily: RATE_RULES.screenQuizDaily,
    screenMonthly: RATE_RULES.screenMonthly,
  });
  const body = await readJson(request, ScreenQuizRequest, MAX_BODY_BYTES);
  assertJpeg(body.image.jpeg);
  geminiEnv();
  const reply = await makeScreenQuiz(
    body,
    screenQuizDeps(deviceToken(request), device.language),
    request.signal,
  );
  return NextResponse.json(reply, { headers: { "Cache-Control": "no-store" } });
});
