import { DeviceLinkRequest } from "@mew/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { assertSameOrigin, handle, readJson, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

/**
 * "This wasn't me" on the browser's desktop sign-in page: that sign-in can't finish, neither by
 * the neb:// link nor by the app's polling (docs/DESKTOP_API.md).
 */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { deviceLink: RATE_RULES.deviceLink });
  const body = await readJson(request, DeviceLinkRequest, 200);
  await userApi("/v1/devices/link-codes/cancel", z.undefined(), { method: "POST", body });
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
});
