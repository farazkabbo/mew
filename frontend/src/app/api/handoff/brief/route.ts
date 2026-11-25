import { HandoffBriefRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { geminiEnv } from "@/server/env";
import { writeBrief } from "@/server/handoff";
import { device, NO_STORE } from "@/server/handoff-routes";
import { handle, readJson } from "@/server/http";
import { askerOf, remainingHeaders, startQuestion } from "@/server/question-gate";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** Snapshots and moments' words, plus up to four crops of ~400 KB. */
const MAX_BODY_BYTES = 2_500_000;

/**
 * Handoff (being built): the brief, from the sender's desktop app (device token). Everything in
 * the body was redacted on the device before it got here. One of the sender's questions; a
 * fallback brief (no model) still costs nothing extra.
 */
export const POST = handle(async (request: Request) => {
  const who = await device(request);
  enforceRateLimit(who.userId, {
    handoffCreate: RATE_RULES.handoffCreate,
    handoffCreateDaily: RATE_RULES.handoffCreateDaily,
  });
  const body = await readJson(request, HandoffBriefRequest, MAX_BODY_BYTES);
  geminiEnv();
  const question = await startQuestion(askerOf(request, who.userId));
  try {
    const made = await question.run(() => writeBrief(body, who.language ?? "en", request.signal));
    await question.finish();
    return NextResponse.json(made, { headers: { ...NO_STORE, ...remainingHeaders(question) } });
  } catch (error) {
    await question.refund();
    throw error;
  }
});
