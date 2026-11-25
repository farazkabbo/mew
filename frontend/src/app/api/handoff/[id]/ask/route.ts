import { HANDOFF_LIMITS, NebLanguage } from "@mew/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { geminiEnv } from "@/server/env";
import { answerQuestion, memberApi, NoContent, packageFor } from "@/server/handoff";
import { handoffId, type IdContext, member, NO_STORE } from "@/server/handoff-routes";
import { assertSameOrigin, handle, readJson } from "@/server/http";
import { askerOf, remainingHeaders, startQuestion } from "@/server/question-gate";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

const Body = z.strictObject({
  question: z.string().trim().min(1).max(HANDOFF_LIMITS.questionChars),
  language: NebLanguage,
});

/**
 * "Ask about this session": answered only from the package, with the moments it comes from.
 * One of the receiver's questions; out-of-package questions say so (and cost nothing).
 */
export const POST = handle(async (request: Request, context: IdContext) => {
  assertSameOrigin(request);
  const who = await member();
  enforceRateLimit(who.userId, {
    handoffAsk: RATE_RULES.handoffAsk,
    handoffAskDaily: RATE_RULES.handoffAskDaily,
  });
  const id = await handoffId(context);
  const body = await readJson(request, Body, 2_000);
  geminiEnv();
  const { manifest } = await packageFor(who, id);
  const question = await startQuestion(askerOf(request, who.userId));
  try {
    const answer = await question.run(() =>
      answerQuestion(manifest, body.question, body.language, request.signal),
    );
    if (answer.covered) await question.finish();
    else await question.refund();
    await memberApi(who, `/v1/handoffs/${id}/events`, NoContent, {
      method: "POST",
      body: { type: "asked" },
    }).catch(() => undefined);
    return NextResponse.json(answer, { headers: { ...NO_STORE, ...remainingHeaders(question) } });
  } catch (error) {
    await question.refund();
    throw error;
  }
});
