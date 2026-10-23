import { ClipPatch, ClipView } from "@mew/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  assertNotCrossSite,
  assertSameOrigin,
  handle,
  HttpError,
  readJson,
  requireUserId,
} from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

type Context = { params: Promise<{ id: string }> };

export async function clipId(context: Context): Promise<string> {
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) throw new HttpError(404, "Not found");
  return id.data;
}

/** A clip the student saved from the screen (S3), read with their own session (RLS). */
export const GET = handle(async (request: Request, context: Context) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { clipRead: RATE_RULES.clipRead });
  const clip = await userApi(`/v1/clips/${await clipId(context)}`, ClipView);
  return NextResponse.json(clip, { headers: { "Cache-Control": "no-store" } });
});

/** Notes which notebook page was built from it (so another tab doesn't build a second one). */
export const PATCH = handle(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { clipRead: RATE_RULES.clipRead });
  const body = await readJson(request, ClipPatch, 200);
  const clip = await userApi(`/v1/clips/${await clipId(context)}`, ClipView, {
    method: "PATCH",
    body,
  });
  return NextResponse.json(clip, { headers: { "Cache-Control": "no-store" } });
});

/** Deletes the clip and its image. */
export const DELETE = handle(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { clipRead: RATE_RULES.clipRead });
  await userApi(`/v1/clips/${await clipId(context)}`, z.undefined(), { method: "DELETE" });
  return new NextResponse(null, { status: 204 });
});
