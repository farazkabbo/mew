import { RECOGNIZE_BATCH_MAX, RecognizeBatchRequest, TUTOR_LIMITS } from "@mew/shared";
import { NextResponse } from "next/server";

import { geminiEnv } from "@/server/env";
import { ModelBusyError } from "@/server/gemini";
import { assertSameOrigin, handle, HttpError, readJson, requireUserId } from "@/server/http";
import { assertPng } from "@/server/png";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { recognizeHandwritingBatch } from "@/server/recognition";

const MAX_BODY_BYTES = RECOGNIZE_BATCH_MAX * TUTOR_LIMITS.lineImageBase64Chars + 10_000;

/**
 * Transcribes up to 8 cropped lines of handwriting in one model call: how Notes Check
 * recognises lines that were never recognised (fewer, larger calls than one per line).
 */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { recognizeBatch: RATE_RULES.recognizeBatch });
  const { images } = await readJson(request, RecognizeBatchRequest, MAX_BODY_BYTES);
  images.forEach((image) => assertPng(image));
  // The daily budget is in lines: a batch of 8 costs 8.
  enforceRateLimit(
    userId,
    { recognizeBatchLinesDaily: RATE_RULES.recognizeBatchLinesDaily },
    { cost: images.length },
  );
  geminiEnv();

  try {
    const lines = await recognizeHandwritingBatch(images);
    return NextResponse.json({ lines }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ModelBusyError) {
      throw new HttpError(429, "Recognition is busy", {
        "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)),
      });
    }
    console.warn("[recognize] batch failed:", error instanceof Error ? error.message : error);
    throw new HttpError(502, "Recognition failed");
  }
});
