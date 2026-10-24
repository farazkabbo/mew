import { ScreenNotesCheckRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { deviceToken, requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { handle, readJson } from "@/server/http";
import { notesCheckFailure } from "@/server/notes-check/errors";
import { runNotesCheck } from "@/server/notes-check/run";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** At most 8,000 characters of screen text, as JSON with block ids and a source link. */
const MAX_BODY_BYTES = 40_000;

/**
 * "Check my notes" from the desktop app (Notes Check, device token). The screen arrives as text
 * blocks read on the device after redaction (never the image); the blocks' positions stay on
 * the device, which places the marks itself. Nothing from the screen is stored beyond the short
 * quotes attached to findings.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    notesCheck: RATE_RULES.notesCheck,
    notesCheckDaily: RATE_RULES.notesCheckDaily,
    notesCheckMonthly: RATE_RULES.notesCheckMonthly,
  });
  const body = await readJson(request, ScreenNotesCheckRequest, MAX_BODY_BYTES);
  geminiEnv(); // 503 before any work when the model isn't configured

  try {
    const result = await runNotesCheck(
      {
        screen: body.screen,
        scope: { kind: body.scope },
        app: body.app,
        ...(body.source && { source: body.source }),
      },
      { kind: "device", token: deviceToken(request) },
      undefined,
      request.signal,
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    throw notesCheckFailure(error);
  }
});
