import "server-only";

import type { z } from "zod";

import { apiEnv } from "./env";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** FastAPI's own explanation of a 4xx (its `detail` text, which the service writes). */
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ApiFetchOptions = {
  /** Clerk session token of the user on whose behalf the call is made. */
  token?: string | null;
  timeoutMs?: number;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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
  options: ApiFetchOptions = {},
): Promise<T> {
  const response = await send(path, options, "application/json");
  const parsed = schema.safeParse(
    response.status === 204 ? undefined : await response.json().catch(() => undefined),
  );
  if (!parsed.success) {
    // Which fields, never their values: enough to see why a route answered 502.
    const fields = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`);
    console.warn(
      `[api] ${path.split("/").slice(0, 3).join("/")} reply refused:`,
      fields.join("; "),
    );
    throw new ApiError("API response did not match the expected schema", response.status);
  }
  return parsed.data;
}

/** Like `apiFetch`, for a binary reply (a clip's image): its bytes and content type. */
export async function apiFetchBytes(
  path: `/${string}`,
  options: ApiFetchOptions = {},
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const response = await send(path, options, "*/*");
  return {
    bytes: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}

async function send(
  path: `/${string}`,
  { token, timeoutMs = 5_000, method = "GET", body, raw, headers: extra }: ApiFetchOptions,
  accept: string,
): Promise<Response> {
  const { API_BASE_URL, INTERNAL_API_SECRET } = apiEnv();
  const base = new URL(API_BASE_URL);
  const url = new URL(path, base);
  if (url.origin !== base.origin) {
    throw new ApiError("Refusing to call a URL outside the API origin", null);
  }

  const headers = new Headers({
    Accept: accept,
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
    let detail: string | null = null;
    if (response.status >= 400 && response.status < 500) {
      const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
      if (typeof body?.detail === "string") detail = body.detail.slice(0, 300);
    }
    throw new ApiError(`API responded with ${response.status}`, response.status, detail);
  }
  return response;
}

function describe(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === "TimeoutError") return "timed out";
  return cause instanceof Error ? cause.message : "unknown error";
}
