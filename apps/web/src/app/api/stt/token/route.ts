import { NextResponse } from "next/server";

import { createSttSession } from "@/server/elevenlabs";
import { assertSameOrigin, handle, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** Issues a single-use speech-to-text session token to the signed-in user. */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    sttToken: RATE_RULES.sttToken,
    sttTokenDaily: RATE_RULES.sttTokenDaily,
  });

  const session = await createSttSession();
  return NextResponse.json(session, { headers: { "Cache-Control": "no-store" } });
});
