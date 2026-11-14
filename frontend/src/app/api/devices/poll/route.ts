import { DevicePollRequest, IssuedDeviceToken } from "@mew/shared";
import { NextResponse } from "next/server";

import { isClerkConfigured } from "@/lib/auth-mode";
import { ApiError, apiFetch } from "@/server/api-client";
import { signInResponse } from "@/server/desktop-sign-in";
import { clientAddress } from "@/server/device-auth";
import { handle, HttpError, readJson } from "@/server/http";
import { LIMITS } from "@/server/limits";
import { limitOrThrow } from "@/server/redis";

/**
 * The desktop app's sign-in fallback (docs/DESKTOP_API.md): every 2 seconds for up to 3 minutes,
 * "has the browser finished?". It proves itself with the PKCE verifier only it knows; the server
 * redeems the code the signed-in page issued for that verifier's challenge. 202 while waiting,
 * 410 when the learner said "This wasn't me", else the same reply as /api/devices/sign-in.
 */
export const POST = handle(async (request: Request) => {
  await limitOrThrow("session:poll", clientAddress(request), LIMITS.rate.pollIp);
  if (!isClerkConfigured) throw new HttpError(503, "Desktop sign-in isn't configured");
  const body = await readJson(request, DevicePollRequest, 400);
  let token: string | null = null;
  try {
    const issued = await apiFetch("/v1/devices/poll", IssuedDeviceToken.nullable(), {
      method: "POST",
      body,
    });
    token = issued?.token ?? null;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 410) {
      return NextResponse.json({ status: "cancelled" }, { status: 410 });
    }
    throw new HttpError(503, "The service is unavailable right now");
  }
  if (!token) {
    return NextResponse.json(
      { status: "waiting" },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  }
  return signInResponse(token);
});
