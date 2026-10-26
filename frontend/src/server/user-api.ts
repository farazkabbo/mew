import "server-only";

import { auth } from "@clerk/nextjs/server";
import type { z } from "zod";

import { isClerkConfigured } from "@/lib/auth-mode";

import { ApiError, apiFetch, apiFetchBytes } from "./api-client";
import { HttpError } from "./http-error";

type Messages = {
  /** The service is unreachable or not configured. */
  unavailable: string;
  notConfigured: string;
  /** Upstream statuses passed on to the browser, with a safe message each. */
  passThrough: ReadonlyMap<number, string>;
  failed: string;
  /**
   * Statuses whose explanation the API service wrote for the student (its own fixed texts, e.g.
   * "Neb can't import password-protected PDFs"): passed on instead of the generic message.
   */
  ownDetail?: ReadonlySet<number>;
};

const GENERIC: Messages = {
  unavailable: "The service is unavailable right now",
  notConfigured: "This isn't configured on the server",
  passThrough: new Map([
    [400, "That request wasn't valid"],
    [404, "Not found"],
    [409, "That isn't possible right now"],
  ]),
  failed: "The request failed",
};

/**
 * Calls the API service as the current user: with their Clerk session token (so Supabase
 * applies RLS), or, in local mode, as the local user (development only; the API refuses that
 * marker in production). Failures become safe HTTP errors (no upstream details).
 */
export async function userApi<T>(
  path: `/${string}`,
  schema: z.ZodType<T>,
  options: Parameters<typeof apiFetch>[2] = {},
  messages: Messages = GENERIC,
): Promise<T> {
  const identity = await caller();
  try {
    return await apiFetch(path, schema, { ...options, ...identity });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    throw toHttpError(error, messages);
  }
}

/** Like `userApi`, for a binary reply (a clip's image). */
export async function userApiBytes(
  path: `/${string}`,
  messages: Messages = GENERIC,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const identity = await caller();
  try {
    return await apiFetchBytes(path, { ...identity, timeoutMs: 15_000 });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    throw toHttpError(error, messages);
  }
}

async function caller(): Promise<{ token?: string; headers?: Record<string, string> }> {
  if (!isClerkConfigured) return { headers: { "X-Mew-Local-User": "local" } };
  const token = await (await auth()).getToken();
  if (!token) throw new HttpError(401, "Unauthorized");
  return { token };
}

function toHttpError(error: ApiError, messages: Messages): HttpError {
  if (error.status === null) return new HttpError(503, messages.unavailable);
  if (error.status === 503) return new HttpError(503, messages.notConfigured);
  if (error.status === 401) return new HttpError(401, "Unauthorized");
  if (error.detail && messages.ownDetail?.has(error.status)) {
    return new HttpError(error.status, error.detail);
  }
  const message = messages.passThrough.get(error.status);
  return message ? new HttpError(error.status, message) : new HttpError(502, messages.failed);
}

export type { Messages as UserApiMessages };
