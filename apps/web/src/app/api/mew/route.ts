import { MewInput } from "@mew/shared";
import { NextResponse } from "next/server";

import { assertSameOrigin, handle, readJson, requireUserId } from "@/server/http";
import { classifyMew } from "@/server/mew-gate";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

const MAX_BODY_BYTES = 8 * 1024;

/** Mew v1 gate: should the tutor respond to what just happened, and how? */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { mew: RATE_RULES.mew, mewDaily: RATE_RULES.mewDaily });
  const input = await readJson(request, MewInput, MAX_BODY_BYTES);

  const decision = await classifyMew(input);
  return NextResponse.json(decision, { headers: { "Cache-Control": "no-store" } });
});
