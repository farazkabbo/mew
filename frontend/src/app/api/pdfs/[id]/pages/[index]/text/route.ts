import { PdfPageText } from "@mew/shared";
import { NextResponse } from "next/server";

import { assertNotCrossSite, handle, requireUserId } from "@/server/http";
import { PDF_MESSAGES, pageIndex, pdfId } from "@/server/pdfs";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

type Context = { params: Promise<{ id: string; index: string }> };

/** One page's text layer, word by word with boxes (K4): the tutor's and Circle & Ask's context. */
export const GET = handle(async (request: Request, context: Context) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { pdfPage: RATE_RULES.pdfPage, pdfPageDaily: RATE_RULES.pdfPageDaily });
  const params = await context.params;
  const text = await userApi(
    `/v1/pdfs/${pdfId(params.id)}/pages/${pageIndex(params.index)}/text`,
    PdfPageText,
    { timeoutMs: 30_000 },
    PDF_MESSAGES,
  );
  return NextResponse.json(text, { headers: { "Cache-Control": "no-store" } });
});
