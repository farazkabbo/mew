import { DeviceExchangeRequest, IssuedDeviceToken } from "@mew/shared";

import { isClerkConfigured } from "@/lib/auth-mode";
import { ApiError, apiFetch } from "@/server/api-client";
import { clientAddress } from "@/server/device-auth";
import { handle, HttpError, readJson } from "@/server/http";
import { signInResponse } from "@/server/desktop-sign-in";
import { LIMITS } from "@/server/limits";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { limitOrThrow } from "@/server/redis";

/**
 * The browser sign-in's last step, called by the desktop app (SCREEN_COACH decision 8a; no browser
 * session, so no Clerk session and no Origin check): redeems a one-time code with the verifier
 * only the desktop app knows, for a Screen Coach device token and a one-minute Clerk ticket that
 * signs the desktop window in as the same user. Both are in this response only.
 */
export const POST = handle(async (request: Request) => {
  enforceRateLimit(clientAddress(request), { deviceExchange: RATE_RULES.deviceExchange });
  // The code exchange: 10 per 10 minutes per address, shared by every instance (LAUNCH_LIMITS).
  await limitOrThrow("session:ip", clientAddress(request), LIMITS.rate.sessionIp);
  if (!isClerkConfigured) throw new HttpError(503, "Desktop sign-in isn't configured");
  const body = await readJson(request, DeviceExchangeRequest, 600);
  let token: string;
  try {
    ({ token } = await apiFetch("/v1/devices/exchange", IssuedDeviceToken, {
      method: "POST",
      body,
    }));
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 400) throw new HttpError(400, "That link has expired. Try again.");
    throw new HttpError(503, "The service is unavailable right now");
  }
  return signInResponse(token);
});
