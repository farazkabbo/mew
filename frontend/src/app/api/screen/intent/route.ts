import { ScreenIntentRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { handle, readJson } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { intentForScreen } from "@/server/screen-intent";

/** The JSON body: a sentence and three small fields. */
const MAX_BODY_BYTES = 4_000;

/**
 * What the student meant by what they said to Screen Coach, from the desktop app (device token):
 * a question, typing into their document, saving, a walkthrough. Words only, never the screen;
 * nothing is stored. It needs no allowance: "Neb, pause" and "save this" work at zero questions,
 * and whatever follows (a question, typing) is gated by its own route.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    screenIntent: RATE_RULES.screenIntent,
    screenIntentDaily: RATE_RULES.screenIntentDaily,
  });
  const body = await readJson(request, ScreenIntentRequest, MAX_BODY_BYTES);
  geminiEnv();
  const reply = await intentForScreen(body, request.signal);
  return NextResponse.json(reply, { headers: { "Cache-Control": "no-store" } });
});
