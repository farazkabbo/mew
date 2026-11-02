import { CoachRecheckRequest } from "@mew/shared";

import { coachFailure, coachReply } from "@/server/coach/http";
import { defaultCoachDeps, recheckCoaching } from "@/server/coach/run";
import { deviceWalkthroughs } from "@/server/coach/store";
import { deviceToken, requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { handle, readJson } from "@/server/http";
import { assertJpeg } from "@/server/jpeg";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** The JSON body: a base64 JPEG (~1 MB at most) plus the student's words. */
const MAX_BODY_BYTES = 1_500_000;

/**
 * Coach mode's re-check (S5 §6): "let me try pivot tables on my own" from the desktop app
 * (device token). Starts a solo walkthrough of a skill learned before; no model call to start
 * (the task is the one already taught), the checks are coach mode's own. The screenshot isn't
 * used to start and is dropped with the request.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    coachStart: RATE_RULES.coachStart,
    coachStartDaily: RATE_RULES.coachStartDaily,
  });
  const body = await readJson(request, CoachRecheckRequest, MAX_BODY_BYTES);
  assertJpeg(body.image.jpeg);
  geminiEnv();

  const store = deviceWalkthroughs(deviceToken(request));
  try {
    return coachReply(await recheckCoaching(body, defaultCoachDeps(store, device.language)));
  } catch (error) {
    throw coachFailure(error);
  }
});
