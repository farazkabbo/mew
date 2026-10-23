import { DeviceList } from "@mew/shared";
import { NextResponse } from "next/server";

import { assertNotCrossSite, handle, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

/** The signed-in user's desktop devices (Settings → Signed-in devices), newest first. */
export const GET = handle(async (request: Request) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { devices: RATE_RULES.devices });
  const list = await userApi("/v1/devices", DeviceList);
  return NextResponse.json(list, { headers: { "Cache-Control": "no-store" } });
});
