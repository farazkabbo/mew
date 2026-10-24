import { CoachResumeRequest } from "@mew/shared";

import { coachFailure, coachReply } from "@/server/coach/http";
import { defaultCoachDeps, resumeCoaching } from "@/server/coach/run";
import { deviceWalkthroughs } from "@/server/coach/store";
import { deviceToken, requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { handle, readJson } from "@/server/http";
import { assertJpeg } from "@/server/jpeg";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** The JSON body: a base64 JPEG (~1 MB at most) and the app's name. */
const MAX_BODY_BYTES = 1_500_000;

/**
 * Coach mode (S4): "continue where we left off" from the desktop app (device token). Picks up
 * the latest unfinished walkthrough and checks its current step on this screen (it may be done).
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    coachStep: RATE_RULES.coachStep,
    coachStepDaily: RATE_RULES.coachStepDaily,
    coachStepMonthly: RATE_RULES.coachStepMonthly,
  });
  const body = await readJson(request, CoachResumeRequest, MAX_BODY_BYTES);
  assertJpeg(body.image.jpeg);
  geminiEnv();

  const store = deviceWalkthroughs(deviceToken(request));
  try {
    return coachReply(await resumeCoaching(body, defaultCoachDeps(store), request.signal));
  } catch (error) {
    throw coachFailure(error);
  }
});
