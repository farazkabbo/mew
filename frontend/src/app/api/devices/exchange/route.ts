import { DeviceExchangeRequest, IssuedDeviceToken } from "@mew/shared";
import { NextResponse } from "next/server";

import { ApiError, apiFetch } from "@/server/api-client";
import { clientAddress } from "@/server/device-auth";
import { handle, HttpError, readJson } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/**
 * Step 3 of desktop sign-in, called by the desktop app (no browser session, so no Clerk and no
 * Origin check): redeems a one-time code with the verifier only the desktop app knows, for a
 * device token. The token is in this response only; the server keeps just its hash.
 */
export const POST = handle(async (request: Request) => {
  enforceRateLimit(clientAddress(request), { deviceExchange: RATE_RULES.deviceExchange });
  const body = await readJson(request, DeviceExchangeRequest, 600);
  try {
    const issued = await apiFetch("/v1/devices/exchange", IssuedDeviceToken, {
      method: "POST",
      body,
    });
    return NextResponse.json(issued, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 400) throw new HttpError(400, "That link has expired. Try again.");
    if (error.status === 503) throw new HttpError(503, "Desktop sign-in isn't configured");
    throw new HttpError(503, "The service is unavailable right now");
  }
});
