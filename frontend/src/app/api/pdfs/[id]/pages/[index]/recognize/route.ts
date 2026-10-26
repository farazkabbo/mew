import { NextResponse } from "next/server";

import { geminiEnv } from "@/server/env";
import { ModelBusyError } from "@/server/gemini";
import { assertSameOrigin, handle, HttpError, requireUserId } from "@/server/http";
import { recognizePdfPage } from "@/server/pdf-ocr";
import { PDF_MESSAGES, pageIndex, pdfId } from "@/server/pdfs";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApiBytes } from "@/server/user-api";

type Context = { params: Promise<{ id: string; index: string }> };

/**
 * "Recognize text" on a scanned page of an imported PDF (K4 §5.2): its picture, drawn by the API
 * service from the student's own file, is read by the model. Only when asked: it costs a call.
 */
export const POST = handle(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    pdfRecognize: RATE_RULES.pdfRecognize,
    pdfRecognizeDaily: RATE_RULES.pdfRecognizeDaily,
  });
  const params = await context.params;
  geminiEnv();
  const { bytes, contentType } = await userApiBytes(
    `/v1/pdfs/${pdfId(params.id)}/pages/${pageIndex(params.index)}/image`,
    PDF_MESSAGES,
  );
  if (contentType !== "image/png") throw new HttpError(502, "Couldn't draw that page");
  try {
    const read = await recognizePdfPage(bytes);
    return NextResponse.json(read, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ModelBusyError) {
      throw new HttpError(429, "Reading pages is busy", {
        "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)),
      });
    }
    console.warn("[pdf-ocr] failed:", error instanceof Error ? error.message : error);
    throw new HttpError(502, "Couldn't read that page");
  }
});
