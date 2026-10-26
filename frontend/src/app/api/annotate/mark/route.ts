import { LiveMarkRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { geminiEnv } from "@/server/env";
import { assertSameOrigin, handle, HttpError, readJson, requireUserId } from "@/server/http";
import { liveMarkNote } from "@/server/live-mark";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

const MAX_BODY_BYTES = 4_000;

/**
 * A margin note for a finished line of writing (K9 §7.1, Coach level): the one model call live
 * annotations make. Its daily budget is what drops the page to Quiet once it's spent (§7.5).
 */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    liveMark: RATE_RULES.liveMark,
    liveMarkDaily: RATE_RULES.liveMarkDaily,
  });
  const body = await readJson(request, LiveMarkRequest, MAX_BODY_BYTES);
  geminiEnv(); // 503 without a model: no margin notes, the rest still marks
  try {
    const note = await liveMarkNote(body);
    return NextResponse.json({ note }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.warn("[annotate] margin note failed:", error instanceof Error ? error.message : error);
    throw new HttpError(502, "No note");
  }
});
