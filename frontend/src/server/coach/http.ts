import "server-only";

import type { CoachReply } from "@mew/shared";
import { NextResponse } from "next/server";

import { ModelBusyError } from "../gemini";
import { HttpError } from "../http-error";

/** A coach reply for the desktop app (never cached: it's about this student's screen). */
export function coachReply(reply: CoachReply): Response {
  return NextResponse.json(reply, { headers: { "Cache-Control": "no-store" } });
}

/** Coach-mode failures as safe HTTP errors: a busy model is 429, anything unexpected 502. */
export function coachFailure(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  if (error instanceof ModelBusyError) return new HttpError(429, "Busy, try again soon");
  console.warn("[coach] request failed:", error instanceof Error ? error.name : "error");
  return new HttpError(502, "Coach mode couldn't answer");
}
