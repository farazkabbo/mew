import { MomentSuggestions, MomentSuggestionsRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { assertSameOrigin, handle, readJson, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

const MAX_BODY_BYTES = 4_000;

/**
 * Unsorted's "File these" (K8 §4.6): a suggested place for each waiting moment, from the
 * student's own tree, course passages, earlier moments and corrections (no model call).
 */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    momentFile: RATE_RULES.momentFile,
    momentFileDaily: RATE_RULES.momentFileDaily,
  });
  const body = await readJson(request, MomentSuggestionsRequest, MAX_BODY_BYTES);
  const suggestions = await userApi("/v1/clips/suggestions", MomentSuggestions, {
    method: "POST",
    body,
  });
  return NextResponse.json(suggestions, { headers: { "Cache-Control": "no-store" } });
});
