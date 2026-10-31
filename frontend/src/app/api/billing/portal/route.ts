import { PortalSessionResponse } from "@mew/shared/src/billing";
import { NextResponse } from "next/server";

import {
  assertSameOrigin,
  handle,
  requireUserId,
} from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

/** Create Stripe customer portal session */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { portal: RATE_RULES.settings });
  
  const response = await userApi("/v1/billing/create-portal-session", PortalSessionResponse, {
    method: "POST",
  });
  
  return NextResponse.json(response);
});

