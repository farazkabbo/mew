import "server-only";

import type { z } from "zod";

import type { apiFetch } from "./api-client";
import { userApi, type UserApiMessages } from "./user-api";

/** Calls longer than this are worth waiting for (lesson generation runs a model). */
const TIMEOUT_MS = 60_000;

const COURSE_MESSAGES: UserApiMessages = {
  unavailable: "Courses are unavailable right now",
  notConfigured: "Courses aren't configured on the server",
  passThrough: new Map([
    [400, "That request wasn't valid"],
    [404, "Course not found"],
    [409, "The course isn't ready for that yet"],
    [413, "PDF too large (15 MB max)"],
    [415, "Send a PDF"],
    [422, "That file isn't a PDF"],
  ]),
  failed: "Courses failed",
};

/** Calls the API service's course (and learner) endpoints as the current user. */
export function coursesApi<T>(
  path: `/${string}`,
  schema: z.ZodType<T>,
  options: Parameters<typeof apiFetch>[2] = {},
): Promise<T> {
  return userApi(path, schema, { timeoutMs: TIMEOUT_MS, ...options }, COURSE_MESSAGES);
}
