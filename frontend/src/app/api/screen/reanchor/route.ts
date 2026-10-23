import { ScreenReanchorRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { ModelBusyError } from "@/server/gemini";
import { handle, HttpError, readJson } from "@/server/http";
import { assertJpeg } from "@/server/jpeg";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { reanchorScreen } from "@/server/screen-reanchor";

/** The JSON body: a base64 JPEG (~1 MB at most), the earlier ink and a little text. */
const MAX_BODY_BYTES = 1_520_000;

/**
 * Screen Coach S3: "show that again" after the page moved, when the desktop app couldn't find
 * the content on the new screen itself (device token). Counts toward the same budget as
 * questions: it's a model call with a screenshot. The screenshot is never stored or logged.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    screen: RATE_RULES.screen,
    screenDaily: RATE_RULES.screenDaily,
    screenMonthly: RATE_RULES.screenMonthly,
  });
  const body = await readJson(request, ScreenReanchorRequest, MAX_BODY_BYTES);
  assertJpeg(body.image.jpeg);
  geminiEnv();
  try {
    const answer = await reanchorScreen(body, request.signal);
    return NextResponse.json(answer, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ModelBusyError) throw new HttpError(429, "Busy, try again soon");
    console.warn("[screen] reanchor failed:", error instanceof Error ? error.name : "error");
    // Not found is the honest answer when the model couldn't say.
    return NextResponse.json(
      { found: false, actions: [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
});
