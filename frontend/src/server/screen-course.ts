import "server-only";

import { COURSE_LIMITS, type CourseExcerpt } from "@mew/shared";
import { z } from "zod";

import { apiFetch } from "./api-client";

/** Kept short: the answer waits for it (the search is skipped rather than slow). */
const COURSE_SEARCH_TIMEOUT_MS = 1_500;
/** Passages a screen answer gets: enough to name the course and page, no more. */
const SCREEN_EXCERPTS = 2;
const SCREEN_EXCERPT_CHARS = 600;

const Retrieved = z.object({
  chunks: z.array(
    z.object({
      page: z.number().int(),
      heading: z.string().nullable(),
      text: z.string(),
      source_title: z.string(),
    }),
  ),
});

/**
 * The student's own course passages closest to what they asked about the screen (Screen Coach
 * S5), so the answer can say "this is the chain rule from your Calc notes, page 12". Searched
 * through the API with the device token: the API picks the courses (the owner's only).
 *
 * Best effort: no words, no courses, a slow search or an error all give [] and the answer goes
 * on without them. The passages are the student's material, never the screen.
 */
export async function screenCourseContext(token: string, words: string): Promise<CourseExcerpt[]> {
  const query = words.trim().slice(0, COURSE_LIMITS.queryChars);
  if (query.split(/\s+/).length < 2) return [];
  try {
    const { chunks } = await apiFetch("/v1/courses/device/retrieve", Retrieved, {
      method: "POST",
      body: { query, k: SCREEN_EXCERPTS },
      headers: { "X-Mew-Device-Token": token },
      timeoutMs: COURSE_SEARCH_TIMEOUT_MS,
    });
    return chunks.slice(0, SCREEN_EXCERPTS).map((c) => ({
      page: Math.min(Math.max(c.page, 1), 2000),
      heading: c.heading?.slice(0, 200) ?? null,
      text: c.text.slice(0, SCREEN_EXCERPT_CHARS),
      source: c.source_title.slice(0, 200),
    }));
  } catch {
    return [];
  }
}
