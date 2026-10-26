import { PdfCourseRequest, PdfCourseStarted } from "@mew/shared";
import { NextResponse } from "next/server";

import { assertSameOrigin, handle, readJson, requireUserId } from "@/server/http";
import { PDF_MESSAGES, pdfId } from "@/server/pdfs";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

type Context = { params: Promise<{ id: string }> };

/**
 * "Use as course material" (K4 §5.1, decision 8): the imported PDF's pages become passages of a
 * course (a new one when the notebook has none), each knowing its chapter. Returns at once;
 * concepts are found in the background.
 */
export const POST = handle(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    courseCreate: RATE_RULES.courseCreate,
    courseCreateDaily: RATE_RULES.courseCreateDaily,
  });
  const id = pdfId((await context.params).id);
  const body = await readJson(request, PdfCourseRequest, 64_000);
  const started = await userApi(
    `/v1/pdfs/${id}/course`,
    PdfCourseStarted,
    { method: "POST", body, timeoutMs: 60_000 },
    PDF_MESSAGES,
  );
  return NextResponse.json(started, { status: 202, headers: { "Cache-Control": "no-store" } });
});
