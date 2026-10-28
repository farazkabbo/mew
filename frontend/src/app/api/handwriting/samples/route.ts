import { HANDWRITING_LIMITS, HandwritingSampleRequest } from "@mew/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { forgetSamples, samplesFor, summarize } from "@/server/handwriting-profile";
import { assertSameOrigin, handle, readJson, requireUserId } from "@/server/http";
import { assertPng } from "@/server/png";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

const MAX_BODY_BYTES =
  HANDWRITING_LIMITS.samplesPerRequest * (HANDWRITING_LIMITS.sampleImageChars + 2_000);
const Saved = z.object({ saved: z.number().int() });
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/**
 * The student's handwriting profile (K10 §8.3). GET: what neb has learned (a count and the
 * look-alikes, never the pictures). POST: samples from calibration or a correction. DELETE:
 * Reset, or turning "Learn my handwriting" off.
 */
export const GET = handle(async () => {
  const userId = await requireUserId();
  forgetSamples(userId);
  return NextResponse.json(summarize(await samplesFor(userId)), NO_STORE);
});

export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { handwritingSamples: RATE_RULES.handwritingSamples });
  const body = await readJson(request, HandwritingSampleRequest, MAX_BODY_BYTES);
  body.samples.forEach((s) => assertPng(s.image));
  const result = await userApi("/v1/handwriting/samples", Saved, { method: "POST", body });
  forgetSamples(userId);
  return NextResponse.json(result, NO_STORE);
});

export const DELETE = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  const result = await userApi("/v1/handwriting/samples", z.object({ deleted: z.number() }), {
    method: "DELETE",
  });
  forgetSamples(userId);
  return NextResponse.json(result, NO_STORE);
});
