import "server-only";

import { auth } from "@clerk/nextjs/server";
import type { z } from "zod";

import { isClerkConfigured } from "@/lib/auth-mode";

import { ApiError, apiFetch } from "./api-client";
import { HttpError } from "./http-error";

/** Calls longer than this are worth waiting for (lesson generation runs a model). */
const TIMEOUT_MS = 60_000;

/**
 * Calls the API service's course endpoints as the current user: with their Clerk session token
 * (so Supabase applies RLS), or, in local mode, as the local user (development only; the API
 * refuses that marker in production). Failures become safe HTTP errors.
 */
export async function coursesApi<T>(
  path: `/${string}`,
  schema: z.ZodType<T>,
  options: Parameters<typeof apiFetch>[2] = {},
): Promise<T> {
  const identity = await caller();
  try {
    return await apiFetch(path, schema, { timeoutMs: TIMEOUT_MS, ...options, ...identity });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    throw toHttpError(error);
  }
}

async function caller(): Promise<{ token?: string; headers?: Record<string, string> }> {
  if (!isClerkConfigured) return { headers: { "X-Mew-Local-User": "local" } };
  const token = await (await auth()).getToken();
  if (!token) throw new HttpError(401, "Unauthorized");
  return { token };
}

const PASS_THROUGH = new Map<number, string>([
  [400, "That request wasn't valid"],
  [404, "Course not found"],
  [409, "The course isn't ready for that yet"],
  [413, "PDF too large (15 MB max)"],
  [415, "Send a PDF"],
  [422, "That file isn't a PDF"],
]);

function toHttpError(error: ApiError): HttpError {
  if (error.status === null) return new HttpError(503, "Courses are unavailable right now");
  if (error.status === 503) return new HttpError(503, "Courses aren't configured on the server");
  if (error.status === 401) return new HttpError(401, "Unauthorized");
  const message = PASS_THROUGH.get(error.status);
  return message ? new HttpError(error.status, message) : new HttpError(502, "Courses failed");
}
