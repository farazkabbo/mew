import { ScreenWatchRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { handle, readJson } from "@/server/http";
import { assertJpeg } from "@/server/jpeg";
import { requireAllowance } from "@/server/question-gate";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { watchScreen } from "@/server/screen-watch";

/** The JSON body: a base64 JPEG (~1 MB at most) plus a few short fields. */
const MAX_BODY_BYTES = 1_500_000;

/**
 * Watch (the island's eye button), from the desktop app (device token): one look at the screen
 * for a slip in the student's working. Like live marks in the notebook it's a background check:
 * it needs the learner's allowance but doesn't spend a question. The screenshot was captured and
 * redacted on the device; it is forwarded to the model and dropped with the request, never stored
 * or logged.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  await requireAllowance(device.userId);
  enforceRateLimit(device.userId, {
    screenWatch: RATE_RULES.screenWatch,
    screenWatchDaily: RATE_RULES.screenWatchDaily,
    screenMonthly: RATE_RULES.screenMonthly,
  });
  const body = await readJson(request, ScreenWatchRequest, MAX_BODY_BYTES);
  assertJpeg(body.image.jpeg);
  geminiEnv();
  const reply = await watchScreen(body, device.language, request.signal);
  return NextResponse.json(reply, { headers: { "Cache-Control": "no-store" } });
});
