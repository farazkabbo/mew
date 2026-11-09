import { NextResponse } from "next/server";

import { createSttSession } from "@/server/elevenlabs";
import { assertSameOrigin, handle, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { requireAllowance } from "@/server/question-gate";

/** Issues a single-use speech-to-text session token to the signed-in user. */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  // Model calls stop when the learner's free questions are used up (docs/LAUNCH_LIMITS.md).
  await requireAllowance(userId);
  enforceRateLimit(userId, {
    sttToken: RATE_RULES.sttToken,
    sttTokenDaily: RATE_RULES.sttTokenDaily,
  });

  const session = await createSttSession();
  return NextResponse.json(session, { headers: { "Cache-Control": "no-store" } });
});
