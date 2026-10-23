import { DeviceLinkCode, DeviceLinkRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { assertSameOrigin, handle, readJson, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

/**
 * Step 2 of desktop sign-in: the signed-in page asks for a one-time code bound to the desktop
 * app's challenge, then hands the code to the desktop app (which redeems it with its verifier).
 */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    deviceLink: RATE_RULES.deviceLink,
    deviceLinkDaily: RATE_RULES.deviceLinkDaily,
  });
  const body = await readJson(request, DeviceLinkRequest, 200);
  const code = await userApi("/v1/devices/link-codes", DeviceLinkCode, { method: "POST", body });
  return NextResponse.json(code, { headers: { "Cache-Control": "no-store" } });
});
