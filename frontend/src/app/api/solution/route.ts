import { SolutionRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { geminiEnv } from "@/server/env";
import { ModelBusyError } from "@/server/gemini";
import { assertSameOrigin, handle, HttpError, readJson, requireUserId } from "@/server/http";
import { assertPng } from "@/server/png";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { solve } from "@/server/solution";
import { unavailableMessage } from "@/server/tutor";

const MAX_BODY_BYTES = 1_700_000;

/**
 * Show-then-You (K6): a worked solution with reasons and a Your Turn, both verified by code
 * before they're returned; "uncertain" when they can't be (the tutor falls back to hints).
 */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    solution: RATE_RULES.solution,
    solutionDaily: RATE_RULES.solutionDaily,
  });
  const body = await readJson(request, SolutionRequest, MAX_BODY_BYTES);
  if (body.pageImage) assertPng(body.pageImage);
  geminiEnv();
  try {
    const result = await solve(body, request.signal);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (request.signal.aborted) throw error;
    console.warn("[solution] failed:", error instanceof Error ? error.name : "error");
    throw new HttpError(error instanceof ModelBusyError ? 503 : 502, unavailableMessage(error));
  }
});
