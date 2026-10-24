import { CoachStartRequest } from "@mew/shared";

import { coachFailure, coachReply } from "@/server/coach/http";
import { defaultCoachDeps, startCoaching } from "@/server/coach/run";
import { deviceWalkthroughs } from "@/server/coach/store";
import { deviceToken, requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { handle, readJson } from "@/server/http";
import { assertJpeg } from "@/server/jpeg";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** The JSON body: a base64 JPEG (~1 MB at most) plus the student's words. */
const MAX_BODY_BYTES = 1_500_000;

/**
 * Coach mode (S4): "teach me how to…" from the desktop app (device token). Plans a walkthrough
 * from the screenshot and the goal, stores it, and answers with step 1 (or why it can't start).
 * The screenshot is forwarded to the model and dropped with the request, never stored or logged.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    coachStart: RATE_RULES.coachStart,
    coachStartDaily: RATE_RULES.coachStartDaily,
  });
  const body = await readJson(request, CoachStartRequest, MAX_BODY_BYTES);
  assertJpeg(body.image.jpeg);
  geminiEnv(); // 503 before any work when the model isn't configured

  const store = deviceWalkthroughs(deviceToken(request));
  try {
    return coachReply(await startCoaching(body, defaultCoachDeps(store), request.signal));
  } catch (error) {
    throw coachFailure(error);
  }
});
