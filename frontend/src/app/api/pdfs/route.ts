import { PdfInfo } from "@mew/shared";
import { NextResponse } from "next/server";

import { assertSameOrigin, handle, HttpError, readBytes, requireUserId } from "@/server/http";
import { fileName, MAX_PDF_BYTES, PDF_MESSAGES } from "@/server/pdfs";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

/**
 * Imports a PDF into the student's notebooks (K4 §5.1): the raw file (`application/pdf`, up to
 * 100 MB, `?fileName=`). It's kept privately for them; its page count, outline and page sizes
 * come back so the import dialog can propose chapters. Pages are drawn later, as they're viewed.
 */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    pdfImport: RATE_RULES.pdfImport,
    pdfImportDaily: RATE_RULES.pdfImportDaily,
  });
  const data = await readBytes(request, "application/pdf", MAX_PDF_BYTES);
  // The bytes, not the browser's word for it.
  if (new TextDecoder().decode(data.slice(0, 5)) !== "%PDF-") {
    throw new HttpError(422, "That file isn't a PDF.");
  }
  const name = fileName(new URL(request.url).searchParams.get("fileName"));
  const info = await userApi(
    `/v1/pdfs?fileName=${encodeURIComponent(name)}`,
    PdfInfo,
    { method: "POST", raw: { data, contentType: "application/pdf" }, timeoutMs: 120_000 },
    PDF_MESSAGES,
  );
  return NextResponse.json(info, { status: 201, headers: { "Cache-Control": "no-store" } });
});
