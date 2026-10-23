import { NextResponse } from "next/server";
import { z } from "zod";

import { assertSameOrigin, handle, HttpError, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

/** Signs one desktop device out (its token stops working at once). */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);
    const userId = await requireUserId();
    enforceRateLimit(userId, { devices: RATE_RULES.devices });
    const id = z.uuid().safeParse((await context.params).id);
    if (!id.success) throw new HttpError(404, "Not found");
    await userApi(`/v1/devices/${id.data}/revoke`, z.undefined(), { method: "POST" });
    return new NextResponse(null, { status: 204 });
  },
);
