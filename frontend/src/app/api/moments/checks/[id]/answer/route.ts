import { MomentCheckAnswer } from "@mew/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { assertSameOrigin, handle, HttpError, readJson, requireUserId } from "@/server/http";
import { answerCheck } from "@/server/moment-checks";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

type Context = { params: Promise<{ id: string }> };

const MAX_BODY_BYTES = 4_000;

/**
 * The student's answer to a moment's check (K8 §4.7): graded here, the card rescheduled, the
 * evidence logged; the reply is the first time the key leaves the server.
 */
export const POST = handle(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    momentAnswer: RATE_RULES.momentAnswer,
    momentAnswerDaily: RATE_RULES.momentAnswerDaily,
  });
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) throw new HttpError(404, "Not found");
  const answer = await readJson(request, MomentCheckAnswer, MAX_BODY_BYTES);
  const result = await answerCheck(id.data, answer);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
});
