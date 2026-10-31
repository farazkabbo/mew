import { clerkClient } from "@clerk/nextjs/server";
import {
  DesktopSignIn,
  DeviceExchangeRequest,
  IssuedDeviceToken,
  VerifiedDevice,
} from "@mew/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { isClerkConfigured } from "@/lib/auth-mode";
import { ApiError, apiFetch } from "@/server/api-client";
import { clientAddress } from "@/server/device-auth";
import { handle, HttpError, readJson } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** Clerk's default is 30 days. The desktop window uses this one within seconds. */
const TICKET_LIFETIME_S = 60;

/**
 * The browser sign-in's last step, called by the desktop app (SCREEN_COACH decision 8a; no browser
 * session, so no Clerk session and no Origin check): redeems a one-time code with the verifier
 * only the desktop app knows, for a Screen Coach device token and a one-minute Clerk ticket that
 * signs the desktop window in as the same user. Both are in this response only.
 */
export const POST = handle(async (request: Request) => {
  enforceRateLimit(clientAddress(request), { deviceExchange: RATE_RULES.deviceExchange });
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
  try {
    // The user the code was issued to, never anything the caller says.
    const { userId } = await apiFetch("/v1/devices/verify", VerifiedDevice, {
      method: "POST",
      body: { token },
    });
    const client = await clerkClient();
    const { token: ticket } = await client.signInTokens.createSignInToken({
      userId,
      expiresInSeconds: TICKET_LIFETIME_S,
    });
    return NextResponse.json(DesktopSignIn.parse({ token, ticket }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // The app won't receive the token, so it mustn't stay active.
    await apiFetch("/v1/devices/revoke-self", z.undefined(), {
      method: "POST",
      body: { token },
    }).catch(() => undefined);
    throw new HttpError(503, "The service is unavailable right now");
  }
});
