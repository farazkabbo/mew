import { NextResponse } from "next/server";

import { assertNotCrossSite, handle, requireUserId } from "@/server/http";
import { stayedCounts } from "@/server/moment-checks";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** What stayed (NEB_APP_UI §6.4): the desk's ribbons and "stayed this week". */
export const GET = handle(async (request: Request) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { momentRead: RATE_RULES.momentRead });
  const stayed = await stayedCounts();
  return NextResponse.json(stayed, { headers: { "Cache-Control": "no-store" } });
});
