import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, apiFetch } from "@/server/api-client";
import { clientAddress, deviceToken } from "@/server/device-auth";
import { handle, HttpError } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/**
 * The desktop app signing out ("Disconnect" in Screen Coach settings): its own token stops
 * working everywhere. Authenticated by that token; an already-revoked token is not an error.
 */
export const POST = handle(async (request: Request) => {
  enforceRateLimit(clientAddress(request), { deviceExchange: RATE_RULES.deviceExchange });
  const token = deviceToken(request);
  try {
    await apiFetch("/v1/devices/revoke-self", z.undefined(), { method: "POST", body: { token } });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    throw new HttpError(503, "The service is unavailable right now");
  }
  return new NextResponse(null, { status: 204 });
});
