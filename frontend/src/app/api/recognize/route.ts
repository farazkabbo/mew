import { RecognizeRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { geminiEnv } from "@/server/env";
import { ModelBusyError } from "@/server/gemini";
import { assertSameOrigin, handle, HttpError, readJson, requireUserId } from "@/server/http";
import { assertPng } from "@/server/png";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { recognizeHandwriting } from "@/server/tutor";

const MAX_BODY_BYTES = 1_700_000;

/** Transcribes a cropped line of handwriting (text, LaTeX, subject). */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    recognize: RATE_RULES.recognize,
    recognizeDaily: RATE_RULES.recognizeDaily,
  });
  const { image } = await readJson(request, RecognizeRequest, MAX_BODY_BYTES);
  assertPng(image);
  geminiEnv();

  try {
    const recognition = await recognizeHandwriting(image);
    return NextResponse.json(recognition, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ModelBusyError) {
      throw new HttpError(429, "Recognition is busy", {
        "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)),
      });
    }
    console.warn("[recognize] failed:", error instanceof Error ? error.message : error);
    throw new HttpError(502, "Recognition failed");
  }
});
