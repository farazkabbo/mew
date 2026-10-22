import { MewEventCreate, MewEventPage } from "@mew/shared";
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
import { logMewDecision } from "@/server/mew-log";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

const Query = z.object({
  unlabeled: z.enum(["true", "false"]).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
});

/** The student's kept gate decisions, newest first (for labelling). */
export const GET = handle(async (request: Request) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { mewEvents: RATE_RULES.mewEvents });
  const query = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) throw new HttpError(400, "That request wasn't valid");
  const params = new URLSearchParams();
  if (query.data.unlabeled === "true") params.set("unlabeled", "true");
  if (query.data.before) params.set("before", query.data.before);
  const page = await userApi(`/v1/mew/events?${params.toString()}`, MewEventPage);
  return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
});

/** Keeps a decision made in the browser by Mew v2 (only with the student's opt-in). */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { mew: RATE_RULES.mew, mewDaily: RATE_RULES.mewDaily });
  const event = await readJson(request, MewEventCreate, 8 * 1024);
  if (event.source !== "local") throw new HttpError(400, "Only on-device decisions are sent here");
  const logged = await logMewDecision(userId, event.input, {
    output: event.output,
    source: "local",
    latencyMs: event.latencyMs,
  });
  return NextResponse.json({ logged });
});

/** Forgets every kept decision. */
export const DELETE = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { mewEvents: RATE_RULES.mewEvents });
  await userApi("/v1/mew/events", z.undefined(), { method: "DELETE" });
  return new NextResponse(null, { status: 204 });
});
