import {
  CheckoutSessionRequest,
  CheckoutSessionResponse,
} from "@mew/shared/src/billing";
import { NextResponse } from "next/server";

import {
  assertSameOrigin,
  handle,
  readJson,
  requireUserId,
} from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

/** Create Stripe checkout session for premium upgrade */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { checkout: RATE_RULES.settings });
  
  const body = await readJson(request, CheckoutSessionRequest, 4_000);
  
  const response = await userApi("/v1/billing/create-checkout-session", CheckoutSessionResponse, {
    method: "POST",
    body,
  });
  
  return NextResponse.json(response);
});

