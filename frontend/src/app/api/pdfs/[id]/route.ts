import { PdfInfo } from "@mew/shared";
import { NextResponse } from "next/server";

import { assertNotCrossSite, handle, requireUserId } from "@/server/http";
import { PDF_MESSAGES, pdfId } from "@/server/pdfs";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

type Context = { params: Promise<{ id: string }> };

/** An imported PDF: its name, page count, outline and course (K4). */
export const GET = handle(async (request: Request, context: Context) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { pdfPage: RATE_RULES.pdfPage });
  const id = pdfId((await context.params).id);
  const info = await userApi(`/v1/pdfs/${id}`, PdfInfo, {}, PDF_MESSAGES);
  return NextResponse.json(info, { headers: { "Cache-Control": "no-store" } });
});
