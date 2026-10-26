import { PdfCourseStarted, type PdfCourseRequest, PdfInfo } from "@mew/shared";

/** Calls to the app's PDF routes (K4), with the student's own session. */

export class PdfApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function failure(response: Response, fallback: string): Promise<PdfApiError> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return new PdfApiError(typeof body?.error === "string" ? body.error : fallback, response.status);
}

/** Keeps the PDF for this student; its page count, outline and page sizes come back. */
export async function uploadPdf(file: File): Promise<PdfInfo> {
  const response = await fetch(
    `/api/pdfs?fileName=${encodeURIComponent(file.name.slice(0, 300))}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: file,
      cache: "no-store",
    },
  );
  if (!response.ok) throw await failure(response, "Couldn't import that PDF. Try again.");
  return PdfInfo.parse(await response.json());
}

/** "Use as course material": the course it went into (a new one when `courseId` is null). */
export async function makeCourseMaterial(
  pdfId: string,
  request: PdfCourseRequest,
): Promise<string> {
  const response = await fetch(`/api/pdfs/${pdfId}/course`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    cache: "no-store",
  });
  if (!response.ok) throw await failure(response, "Couldn't make it course material.");
  return PdfCourseStarted.parse(await response.json()).courseId;
}
