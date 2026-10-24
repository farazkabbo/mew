import { EntryAppendRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { appendToEntry } from "@/server/clips";
import { deviceToken, requireDevice } from "@/server/device-auth";
import { handle, readJson } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** A follow-up's words and ink (no picture). */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Circle & Ask (S3.2 §5): a follow-up in a session, added to the entry its first question made.
 * From the desktop app (device token), after the follow-up's toast ended; counts as a clip save.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, { clip: RATE_RULES.clip, clipDaily: RATE_RULES.clipDaily });
  const append = await readJson(request, EntryAppendRequest, MAX_BODY_BYTES);
  const added = await appendToEntry(deviceToken(request), append);
  return NextResponse.json(added, { headers: { "Cache-Control": "no-store" } });
});
