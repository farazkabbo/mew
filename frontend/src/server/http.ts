import "server-only";

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { z } from "zod";

import { isClerkConfigured, LOCAL_USER_ID } from "@/lib/auth-mode";

import { appEnv, EnvError } from "./env";
import { HttpError } from "./http-error";

export { HttpError };

/** The signed-in user's id; in local mode (development only) a fixed local id. */
export async function requireUserId(): Promise<string> {
  if (!isClerkConfigured) {
    if (process.env.NODE_ENV === "production")
      throw new HttpError(503, "Authentication is not configured");
    return LOCAL_USER_ID;
  }
  const { userId } = await auth();
  if (!userId) throw new HttpError(401, "Unauthorized");
  return userId;
}

/**
 * Rejects cross-origin state-changing requests (CSRF defence in depth on top of SameSite
 * cookies and JSON-only bodies).
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin !== appEnv().APP_ORIGIN) throw new HttpError(403, "Cross-origin request refused");
}

/**
 * For read-only GETs (browsers send no Origin on same-origin GETs): refuse requests the browser
 * marks as coming from another site. Reading the response cross-origin is blocked by CORS anyway.
 */
export function assertNotCrossSite(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    throw new HttpError(403, "Cross-site request refused");
  }
}

/** Reads and validates a JSON body, refusing anything larger than `maxBytes`. */
export async function readJson<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes: number,
): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Expected application/json");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "Request body too large");

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new HttpError(413, "Request body too large");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Malformed JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, "Invalid request body");
  return parsed.data;
}

/**
 * Reads a multipart form, refusing bodies over `maxBytes` while streaming (so a missing or
 * false Content-Length can't make the server buffer an arbitrarily large upload).
 */
export async function readForm(request: Request, maxBytes: number): Promise<FormData> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) {
    throw new HttpError(415, "Expected multipart/form-data");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "Request body too large");
  if (!request.body) throw new HttpError(400, "Empty upload");

  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      // Stop reading (backpressure halts the sender); cancelling would make the body's
      // producer throw on its next write.
      reader.releaseLock();
      throw new HttpError(413, "Request body too large");
    }
    parts.push(value);
  }
  try {
    return await new Response(new Blob(parts as BlobPart[]), {
      headers: { "content-type": type },
    }).formData();
  } catch {
    throw new HttpError(400, "Malformed upload");
  }
}

/** Wraps a route handler: HttpErrors become JSON responses; anything else is a logged 500. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof HttpError) {
        return NextResponse.json(
          { error: error.message },
          { status: error.status, headers: { "Cache-Control": "no-store", ...error.headers } },
        );
      }
      if (error instanceof EnvError) {
        // The variable names are logged for the operator; the client only learns it's unavailable.
        console.error("[api]", error.message);
        return NextResponse.json(
          { error: "This feature is not configured" },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
      console.error("[api] unhandled error", error);
      return NextResponse.json(
        { error: "Internal error" },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
  };
}
