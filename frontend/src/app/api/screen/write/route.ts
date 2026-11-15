import { ScreenWriteRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { handle, readJson } from "@/server/http";
import { assertJpeg } from "@/server/jpeg";
import { requireAllowance } from "@/server/question-gate";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { writeForScreen } from "@/server/screen-write";

/** The JSON body: a base64 JPEG (~1 MB at most) plus what the student said. */
const MAX_BODY_BYTES = 1_500_000;

/**
 * Typing into a document ("rewrite this sentence", "type a conclusion"), from the desktop app
 * (device token): the text to type and a sentence to say first. The desktop types it; this route
 * only writes it. The screenshot was captured and redacted on the device; it is forwarded to the
 * model and dropped with the request, never stored or logged.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  await requireAllowance(device.userId);
  enforceRateLimit(device.userId, {
    screenWrite: RATE_RULES.screenWrite,
    screenWriteDaily: RATE_RULES.screenWriteDaily,
    screenMonthly: RATE_RULES.screenMonthly,
  });
  const body = await readJson(request, ScreenWriteRequest, MAX_BODY_BYTES);
  assertJpeg(body.image.jpeg);
  geminiEnv();
  const reply = await writeForScreen(body, device.language, request.signal);
  return NextResponse.json(reply, { headers: { "Cache-Control": "no-store" } });
});
