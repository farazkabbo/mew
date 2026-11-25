import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { apiFetch } from "@/server/api-client";
import { mapApi } from "@/server/handoff";
import { handle, HttpError } from "@/server/http";

/**
 * The daily job (a cron with `Authorization: Bearer $CRON_SECRET`): expired and revoked handoffs
 * are hard-deleted with their packages, keys, members, events and replies.
 */
export const GET = handle(async (request: Request) => {
  const secret = process.env.CRON_SECRET ?? "";
  const given = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const ok =
    secret.length >= 16 &&
    given.length === secret.length &&
    timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) throw new HttpError(401, "Unauthorized");
  const purged = await apiFetch("/v1/handoffs/maintenance/purge", z.object({ count: z.number() }), {
    method: "POST",
    timeoutMs: 60_000,
  }).catch(mapApi);
  return NextResponse.json(purged);
});
