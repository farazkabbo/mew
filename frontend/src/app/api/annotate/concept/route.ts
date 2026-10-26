import { LiveConceptRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { geminiEnv } from "@/server/env";
import { assertSameOrigin, handle, HttpError, readJson, requireUserId } from "@/server/http";
import { liveConcept } from "@/server/live-concept";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

const MAX_BODY_BYTES = 4_000;

/**
 * Which course concept a line of verified working practises (K9 §7.4: evidence for a right line
 * on a page without a worked solution). The device asks once per page and keeps the answer.
 */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    liveConcept: RATE_RULES.liveConcept,
    liveConceptDaily: RATE_RULES.liveConceptDaily,
  });
  const body = await readJson(request, LiveConceptRequest, MAX_BODY_BYTES);
  geminiEnv(); // 503 without a model: no evidence is logged, the marks are unchanged
  try {
    const conceptId = await liveConcept(body);
    return NextResponse.json({ conceptId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.warn("[annotate] concept failed:", error instanceof Error ? error.message : error);
    throw new HttpError(502, "No concept");
  }
});
