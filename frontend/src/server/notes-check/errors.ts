import "server-only";

import { ModelBusyError } from "../gemini";
import { HttpError } from "../http-error";

/** A failed check as a safe HTTP error: busy model → 429 with Retry-After; details only logged. */
export function notesCheckFailure(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ModelBusyError) {
    return new HttpError(429, "The tutor is busy right now", {
      "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)),
    });
  }
  console.warn("[notes-check] failed:", error instanceof Error ? error.name : "error");
  return new HttpError(502, "Couldn't check your notes just now");
}
