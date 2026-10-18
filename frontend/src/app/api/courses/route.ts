import { COURSE_LIMITS, Course, CourseList } from "@mew/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { coursesApi } from "@/server/courses";
import {
  assertNotCrossSite,
  assertSameOrigin,
  handle,
  HttpError,
  readForm,
  requireUserId,
} from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** Multipart overhead on top of the PDF itself. */
const MAX_BODY_BYTES = COURSE_LIMITS.pdfBytes + 64 * 1024;
const Title = z.string().trim().min(1).max(COURSE_LIMITS.titleChars);

/** The student's courses. */
export const GET = handle(async (request: Request) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { courseRead: RATE_RULES.courseRead });
  const courses = await coursesApi("/v1/courses", CourseList);
  return NextResponse.json(courses, { headers: { "Cache-Control": "no-store" } });
});

/**
 * Starts building a course from an uploaded PDF (multipart: `file`, `title`). Returns the new
 * course at once; it moves from "processing" to "review" as the server works through it.
 */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    courseCreate: RATE_RULES.courseCreate,
    courseCreateDaily: RATE_RULES.courseCreateDaily,
  });

  const form = await readForm(request, MAX_BODY_BYTES);
  const file = form.get("file");
  const title = Title.safeParse(form.get("title"));
  if (!(file instanceof File) || !title.success) {
    throw new HttpError(400, "Upload a PDF file and give the course a title");
  }
  if (file.size > COURSE_LIMITS.pdfBytes) throw new HttpError(413, "PDF too large (15 MB max)");
  const data = await file.arrayBuffer();
  // Check the bytes, not the browser-reported type.
  if (new TextDecoder().decode(data.slice(0, 5)) !== "%PDF-") {
    throw new HttpError(422, "That file isn't a PDF");
  }

  const course = await coursesApi(`/v1/courses?title=${encodeURIComponent(title.data)}`, Course, {
    method: "POST",
    raw: { data, contentType: "application/pdf" },
  });
  return NextResponse.json(course, { status: 202 });
});
