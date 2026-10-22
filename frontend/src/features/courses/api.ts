import {
  type AttemptRequest,
  ConceptProgress,
  type ConceptReview,
  Course,
  CourseDetail,
  CourseList,
  CourseProgress,
  type CourseUpdate,
  Lesson,
  ReviewQueue,
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
  progress: (id: string) => call(`/api/courses/${id}/progress`, CourseProgress),
  /** Records an answer; returns the concept's new progress. */
  attempt: (id: string, attempt: AttemptRequest) =>
    call(`/api/courses/${id}/attempts`, ConceptProgress, json("POST", attempt)),
  /** The lesson was opened: the concept counts as explored and joins the review queue. */
  explored: (id: string, conceptId: string) =>
    call(`/api/courses/${id}/concepts/${conceptId}/explored`, z.undefined(), json("POST", {})),
  /** Concepts due for review across all courses. */
  dueReviews: () => call("/api/review", ReviewQueue),
};

/** "/notebook" for this course: opens (or creates) the course's own notebook. */
export function notebookHref(course: { id: string; title: string }): string {
  const params = new URLSearchParams({ course: course.id, title: course.title });
  return `/notebook?${params.toString()}`;
}

/** The course notebook with a quiz started on arrival ("Quiz me"). */
export function quizHref(course: { id: string; title: string }): string {
  return `${notebookHref(course)}&quiz=1`;
}

/** "due now", "in 3 days", "tomorrow", "3 days ago" — for review dates. */
export function formatDue(due: string, now = new Date()): string {
  const days = Math.round((Date.parse(due) - now.getTime()) / 86_400_000);
  if (Date.parse(due) <= now.getTime()) return days <= -1 ? `due ${-days}d ago` : "due now";
  if (days <= 0) return "later today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
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
