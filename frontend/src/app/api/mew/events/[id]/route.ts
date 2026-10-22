import { LabelUpdate } from "@mew/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { assertSameOrigin, handle, HttpError, readJson, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

/** Labels one kept decision with what Mew should have done (or clears the label). */
export const PATCH = handle(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);
    const userId = await requireUserId();
    enforceRateLimit(userId, { mewEvents: RATE_RULES.mewEvents });
    const id = z.uuid().safeParse((await context.params).id);
    if (!id.success) throw new HttpError(404, "Not found");
    const body = await readJson(request, LabelUpdate, 200);
    await userApi(`/v1/mew/events/${id.data}`, z.undefined(), { method: "PATCH", body });
    return new NextResponse(null, { status: 204 });
  },
);
