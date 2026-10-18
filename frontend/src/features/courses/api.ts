import {
  type ConceptReview,
  Course,
  CourseDetail,
  CourseList,
  type CourseUpdate,
  Lesson,
} from "@mew/shared";
import { z } from "zod";

/** A failed course request, with the server's (safe, user-facing) message. */
export class CourseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CourseApiError";
  }
}

async function call<T>(url: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store" });
  } catch {
    throw new CourseApiError("Can't reach the server. Check your connection.", 0);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const message = typeof body?.error === "string" ? body.error : "Something went wrong.";
    throw new CourseApiError(message, response.status);
  }
  return schema.parse(response.status === 204 ? undefined : await response.json());
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const coursesApi = {
  list: () => call("/api/courses", CourseList),
  get: (id: string) => call(`/api/courses/${id}`, CourseDetail),
  create: (file: File, title: string) => {
    const form = new FormData();
    form.set("file", file);
    form.set("title", title);
    return call("/api/courses", Course, { method: "POST", body: form });
  },
  update: (id: string, patch: CourseUpdate) =>
    call(`/api/courses/${id}`, CourseDetail, json("PATCH", patch)),
  review: (id: string, review: ConceptReview) =>
    call(`/api/courses/${id}/review`, CourseDetail, json("POST", review)),
  remove: (id: string) => call(`/api/courses/${id}`, z.undefined(), { method: "DELETE" }),
  lesson: (id: string, conceptId: string) =>
    call(`/api/courses/${id}/concepts/${conceptId}/lesson`, Lesson),
};

/** "/notebook" for this course: opens (or creates) the course's own notebook. */
export function notebookHref(course: { id: string; title: string }): string {
  const params = new URLSearchParams({ course: course.id, title: course.title });
  return `/notebook?${params.toString()}`;
}

/** "p. 3", "pp. 3–5, 9" */
export function formatPages(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const ranges: string[] = [];
  let start = sorted[0] ?? 0;
  let prev = start;
  for (const page of [...sorted.slice(1), Infinity]) {
    if (page === prev + 1) {
      prev = page;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = page;
    prev = page;
  }
  return `${sorted.length === 1 ? "p." : "pp."} ${ranges.join(", ")}`;
}
