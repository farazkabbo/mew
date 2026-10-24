import { ReadQuestionRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { readQuestion } from "@/server/circle-ask";
import { requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { ModelBusyError } from "@/server/gemini";
import { handle, HttpError, readJson } from "@/server/http";
import { assertJpeg } from "@/server/jpeg";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** A small base64 JPEG: the area the student selected. */
const MAX_BODY_BYTES = 420_000;

/**
 * Circle & Ask (S3.2 §3.5): reads a question the student selected on their screen when the
 * device's own text recognition couldn't (handwriting). From the desktop app (device token). The
 * crop is forwarded to the model and dropped, never stored or logged.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    readQuestion: RATE_RULES.readQuestion,
    readQuestionDaily: RATE_RULES.readQuestionDaily,
  });
  const body = await readJson(request, ReadQuestionRequest, MAX_BODY_BYTES);
  assertJpeg(body.image.jpeg);
  geminiEnv();
  try {
    const read = await readQuestion(body, request.signal);
    return NextResponse.json(read, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ModelBusyError) throw new HttpError(429, "Busy, try again soon");
    console.warn(
      "[circle] reading a question failed:",
      error instanceof Error ? error.name : "error",
    );
    // Nothing read is the honest answer: the student can type it instead.
    return NextResponse.json(
      { questions: [], handwritten: false, confidence: 0 },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
});
