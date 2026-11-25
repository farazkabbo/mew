import { NebLanguage } from "@mew/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { geminiEnv } from "@/server/env";
import {
  memberApi,
  NoContent,
  packageFor,
  segmentsOf,
  walkthroughFor,
  writeWalkthrough,
} from "@/server/handoff";
import { handoffId, type IdContext, member, NO_STORE } from "@/server/handoff-routes";
import { assertSameOrigin, handle, readJson } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

const Body = z.strictObject({ language: NebLanguage });

/**
 * The spoken walkthrough's script, in the receiver's language, with the moment each part shows.
 * Free to the receiver, and made once per (handoff, language): later opens and concurrent first
 * opens read the cache (a Redis single-flight lock).
 */
export const POST = handle(async (request: Request, context: IdContext) => {
  assertSameOrigin(request);
  const who = await member();
  enforceRateLimit(who.userId, { handoffOpen: RATE_RULES.handoffOpen });
  const id = await handoffId(context);
  const { language } = await readJson(request, Body, 200);
  geminiEnv();
  const { manifest } = await packageFor(who, id);
  const script = await walkthroughFor(id, language, () =>
    writeWalkthrough(manifest, language, request.signal),
  );
  await memberApi(who, `/v1/handoffs/${id}/events`, NoContent, {
    method: "POST",
    body: { type: "walkthrough_played" },
  }).catch(() => undefined);
  return NextResponse.json(
    { script, segments: segmentsOf(script, manifest) },
    { headers: NO_STORE },
  );
});
