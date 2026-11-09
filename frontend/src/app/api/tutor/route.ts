import { TutorRequest } from "@mew/shared";

import { geminiEnv } from "@/server/env";
import { assertSameOrigin, handle, readJson, requireUserId } from "@/server/http";
import { assertPng } from "@/server/png";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { LIMITS } from "@/server/limits";
import { askerOf, questionStream, startQuestion } from "@/server/question-gate";
import { runTutor } from "@/server/tutor";

const MAX_BODY_BYTES = 1_700_000;

/**
 * One tutor turn, streamed as newline-delimited JSON events (`speech`, then `response`) so the
 * client can start speaking before board actions finish generating.
 */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { tutor: RATE_RULES.tutor, tutorDaily: RATE_RULES.tutorDaily });
  const body = await readJson(request, TutorRequest, MAX_BODY_BYTES);
  if (body.pageImage) assertPng(body.pageImage);
  geminiEnv(); // fail fast with 503 (before streaming) when the model isn't configured

  // A spoken notebook turn soon after the last one continues that question (LAUNCH_LIMITS.md).
  const question = await startQuestion(askerOf(request, userId), {
    key: `q:notebook:${userId}`,
    cap: LIMITS.followUps,
    ttlMs: LIMITS.notebookFollowUpMs,
  });
  return questionStream(
    question,
    () => runTutor(body, request.signal),
    (event) => event.type === "speech" || event.type === "response",
  );
});
