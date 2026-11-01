import { UnplacedEntries } from "@mew/shared";
import { NextResponse } from "next/server";

import { assertNotCrossSite, handle, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

/** Entries saved from the screen that no notebook has a page for yet (ids only, the owner's). */
export const GET = handle(async (request: Request) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { clipRead: RATE_RULES.clipRead });
  const unplaced = await userApi("/v1/clips/unplaced", UnplacedEntries);
  return NextResponse.json(unplaced, { headers: { "Cache-Control": "no-store" } });
});
