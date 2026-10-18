import { MathCheckRequest, MathCheckResponse } from "@mew/shared";
import { NextResponse } from "next/server";

import { ApiError, apiFetch } from "@/server/api-client";
import { assertSameOrigin, handle, HttpError, readJson, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** 8 steps × 300 characters, JSON-escaped, with room to spare. */
const MAX_BODY_BYTES = 8_000;

/**
 * Checks whether each line of working follows from the one before (SymPy on the internal API
 * service). The browser never calls that service itself.
 */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { check: RATE_RULES.check, checkDaily: RATE_RULES.checkDaily });
  const body = await readJson(request, MathCheckRequest, MAX_BODY_BYTES);

  try {
    const result = await apiFetch("/v1/check/math", MathCheckResponse, {
      method: "POST",
      body,
      timeoutMs: 8000,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    console.warn("[check] API call failed:", error.message);
    // Unreachable service: 503 tells the client to stop asking this session.
    throw new HttpError(error.status === null ? 503 : 502, "Checker unavailable");
  }
});
