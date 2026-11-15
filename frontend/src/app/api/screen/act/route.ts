import { ScreenActRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { handle, readJson } from "@/server/http";
import { assertJpeg } from "@/server/jpeg";
import { requireAllowance } from "@/server/question-gate";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { actOnScreen } from "@/server/screen-act";

/** The JSON body: a base64 JPEG (~1 MB at most), the goal and a short history. */
const MAX_BODY_BYTES = 1_500_000;

/**
 * Neb's hand, from the desktop app (device token): the one next action for Neb's cursor (a
 * click, a scroll, a key, a short line of typing, done or stop). The desktop performs it; this
 * route only chooses it, and refuses controls that are the student's to press. The screenshot
 * was captured and redacted on the device; it is forwarded to the model and dropped with the
 * request, never stored or logged.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  await requireAllowance(device.userId);
  enforceRateLimit(device.userId, {
    screenAct: RATE_RULES.screenAct,
    screenActDaily: RATE_RULES.screenActDaily,
    screenMonthly: RATE_RULES.screenMonthly,
  });
  const body = await readJson(request, ScreenActRequest, MAX_BODY_BYTES);
  assertJpeg(body.image.jpeg);
  geminiEnv();
  const reply = await actOnScreen(body, device.language, request.signal);
  return NextResponse.json(reply, { headers: { "Cache-Control": "no-store" } });
});
