import { assertNotCrossSite, handle, HttpError, requireUserId } from "@/server/http";
import { PDF_MESSAGES, pageIndex, pdfId } from "@/server/pdfs";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApiBytes } from "@/server/user-api";

type Context = { params: Promise<{ id: string; index: string }> };

/**
 * One page of an imported PDF, drawn as a PNG (K4), to go under the student's ink. The device
 * keeps it for offline use; the browser's HTTP cache never does.
 */
export const GET = handle(async (request: Request, context: Context) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { pdfPage: RATE_RULES.pdfPage, pdfPageDaily: RATE_RULES.pdfPageDaily });
  const params = await context.params;
  const { bytes, contentType } = await userApiBytes(
    `/v1/pdfs/${pdfId(params.id)}/pages/${pageIndex(params.index)}/image`,
    PDF_MESSAGES,
  );
  if (contentType !== "image/png") throw new HttpError(502, "Couldn't draw that page");
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
