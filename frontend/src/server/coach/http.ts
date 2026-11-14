import "server-only";

import type { CoachReply } from "@mew/shared";
import { NextResponse } from "next/server";

import { ModelBusyError } from "../gemini";
import { HttpError } from "../http-error";
import { LIMITS } from "../limits";
import { type Question, rememberGroup, remainingHeaders } from "../question-gate";

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

/**
 * A coach request as one of the learner's questions (docs/LAUNCH_LIMITS.md): the work runs
 * counted against `question`, which is finished when the reply reached the learner and refunded
 * when it failed or nothing started. A walkthrough's later steps belong to the same question.
 */
export async function coachQuestion(
  question: Question,
  userId: string,
  work: () => Promise<CoachReply>,
): Promise<Response> {
  let reply: CoachReply;
  try {
    reply = await question.run(work);
  } catch (error) {
    await question.refund();
    throw coachFailure(error);
  }
  if (reply.status === "declined") {
    await question.refund();
  } else {
    await question.finish();
    if (reply.walkthroughId && !question.followUp) {
      await rememberGroup(
        { key: walkthroughKey(reply.walkthroughId), cap: LIMITS.walkthroughSteps },
        userId,
        question.id,
      );
    }
  }
  return NextResponse.json(reply, {
    headers: { "Cache-Control": "no-store", ...remainingHeaders(question) },
  });
}

/** The follow-up group of a walkthrough's steps. */
export const walkthroughKey = (id: string) => `q:walk:${id}`;
