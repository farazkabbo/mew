import "server-only";

import { clerkClient } from "@clerk/nextjs/server";
import { DesktopSignIn, VerifiedDevice } from "@mew/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiFetch } from "./api-client";
import { HttpError } from "./http-error";

/** Clerk's default is 30 days. The desktop window uses this one within seconds. */
const TICKET_LIFETIME_S = 60;

/**
 * The end of a desktop sign-in, by link or by polling (docs/DESKTOP_API.md): a one-minute Clerk
 * ticket for the user the device token was issued to (never anyone the caller names), with the
 * token. If the ticket can't be made, the token is revoked: the app won't receive it.
 */
export async function signInResponse(token: string): Promise<Response> {
  try {
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
    await apiFetch("/v1/devices/revoke-self", z.undefined(), {
      method: "POST",
      body: { token },
    }).catch(() => undefined);
    throw new HttpError(503, "The service is unavailable right now");
  }
}
