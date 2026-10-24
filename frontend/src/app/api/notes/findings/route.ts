import { StoredFinding } from "@mew/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { assertNotCrossSite, handle, HttpError, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

/** A page's findings still open: its Notes Check marks after a reload. */
export const GET = handle(async (request: Request) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { notesFindings: RATE_RULES.notesFindings });
  const pageId = z.uuid().safeParse(new URL(request.url).searchParams.get("pageId"));
  if (!pageId.success) throw new HttpError(400, "That request wasn't valid");
  const findings = await userApi(
    `/v1/notes/findings?page_id=${pageId.data}`,
    z.array(StoredFinding),
  );
  return NextResponse.json(findings, { headers: { "Cache-Control": "no-store" } });
});
