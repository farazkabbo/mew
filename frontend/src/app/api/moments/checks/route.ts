import { NextResponse } from "next/server";

import { assertNotCrossSite, assertSameOrigin, handle, requireUserId } from "@/server/http";
import { clearChecks, dueChecks } from "@/server/moment-checks";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/**
 * A saved moment's check questions (K8 §4.7): every active one with when it's due (never its
 * key), for the review, the Quick check and the chapter badges.
 */
export const GET = handle(async (request: Request) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { momentRead: RATE_RULES.momentRead });
  const due = await dueChecks();
  return NextResponse.json(due, { headers: { "Cache-Control": "no-store" } });
});

/** "Quiz me on things I save" turned off, with "clear them too". */
export const DELETE = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { momentRead: RATE_RULES.momentRead });
  await clearChecks();
  return new Response(null, { status: 204 });
});
