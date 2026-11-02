import { CoachStepRequest } from "@mew/shared";

import { coachFailure, coachReply } from "@/server/coach/http";
import { defaultCoachDeps, stepCoaching } from "@/server/coach/run";
import { deviceWalkthroughs } from "@/server/coach/store";
import { deviceToken, requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { handle, readJson } from "@/server/http";
import { assertJpeg } from "@/server/jpeg";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** The JSON body: a base64 JPEG (~1 MB at most) for a check, or just the event. */
const MAX_BODY_BYTES = 1_500_000;

/**
 * Coach mode (S4): one event in a walkthrough, from the desktop app (device token). "done" and
 * "stuck" check the step on the screenshot (one fast model call); "yes", "pause" and "stop" call
 * no model. Answers with what to say and show next.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    coachStep: RATE_RULES.coachStep,
    coachStepDaily: RATE_RULES.coachStepDaily,
    coachStepMonthly: RATE_RULES.coachStepMonthly,
  });
  const body = await readJson(request, CoachStepRequest, MAX_BODY_BYTES);
  if ("image" in body) {
    assertJpeg(body.image.jpeg);
    geminiEnv();
  }

  const store = deviceWalkthroughs(deviceToken(request));
  try {
    return coachReply(
      await stepCoaching(body, defaultCoachDeps(store, device.language), request.signal),
    );
  } catch (error) {
    throw coachFailure(error);
  }
});
