import { NextResponse } from "next/server";
import { z } from "zod";

import { assertSameOrigin, handle, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

/** Signs every desktop device of the user out. */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { devices: RATE_RULES.devices });
  await userApi("/v1/devices/revoke-all", z.undefined(), { method: "POST" });
  return new NextResponse(null, { status: 204 });
});
