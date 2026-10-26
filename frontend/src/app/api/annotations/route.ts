import { AnnotationSyncRequest, AnnotationSyncResult } from "@mew/shared";
import { NextResponse } from "next/server";

import { assertSameOrigin, handle, readJson, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

const MAX_BODY_BYTES = 64_000;

/**
 * The device's live annotations (K9 §7.3): what each mark was and how it ended, sent once made
 * and again when resolved or dismissed. No strokes; the text only with `notes_index` on (the
 * device leaves it out otherwise).
 */
export const PUT = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { annotationsSync: RATE_RULES.annotationsSync });
  const body = await readJson(request, AnnotationSyncRequest, MAX_BODY_BYTES);
  const result = await userApi("/v1/annotations", AnnotationSyncResult, {
    method: "PUT",
    body,
  });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
});
