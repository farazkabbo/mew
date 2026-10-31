import { BillingInfo } from "@mew/shared/src/billing";
import { NextResponse } from "next/server";

import {
  assertNotCrossSite,
  handle,
  requireUserId,
} from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

/** Get user's billing status (subscription + usage) */
export const GET = handle(async (request: Request) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { billing: RATE_RULES.settings }); // Same rate as settings
  
  const billing = await userApi("/v1/billing/status", BillingInfo);
  
  return NextResponse.json(billing, { headers: { "Cache-Control": "no-store" } });
});

