import "server-only";

import type { z } from "zod";

import { apiEnv } from "./env";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ApiFetchOptions = {
  /** Clerk session token of the user on whose behalf the call is made. */
  token?: string | null;
  timeoutMs?: number;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** JSON body. */
  body?: unknown;
  /** A raw body (e.g. an uploaded PDF), sent with its own content type. */
  raw?: { data: ArrayBuffer; contentType: string };
  headers?: Record<string, string>;
};

/**
 * Calls the internal FastAPI service. The browser never talks to that service directly: every call
 * carries the shared internal secret, plus the user's Clerk token when acting for a user.
 */
export async function apiFetch<T>(
  path: `/${string}`,
  schema: z.ZodType<T>,
  { token, timeoutMs = 5_000, method = "GET", body, raw, headers: extra }: ApiFetchOptions = {},
): Promise<T> {
  const { API_BASE_URL, INTERNAL_API_SECRET } = apiEnv();
  const base = new URL(API_BASE_URL);
  const url = new URL(path, base);
  if (url.origin !== base.origin) {
    throw new ApiError("Refusing to call a URL outside the API origin", null);
  }

  const headers = new Headers({
    Accept: "application/json",
    "X-Internal-Secret": INTERNAL_API_SECRET,
  });
  for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (raw) headers.set("Content-Type", raw.contentType);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: raw ? raw.data : body === undefined ? null : JSON.stringify(body),
      cache: "no-store",
      // Never follow redirects: they could forward the internal secret to another host.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new ApiError(`API request failed: ${describe(cause)}`, null);
  }

  if (!response.ok) {
    throw new ApiError(`API responded with ${response.status}`, response.status);
  }

  const parsed = schema.safeParse(
    response.status === 204 ? undefined : await response.json().catch(() => undefined),
  );
  if (!parsed.success) {
    throw new ApiError("API response did not match the expected schema", response.status);
  }
  return parsed.data;
}

function describe(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === "TimeoutError") return "timed out";
  return cause instanceof Error ? cause.message : "unknown error";
}
