import type { VoiceList } from "@mew/shared";
import { NextResponse } from "next/server";
import type { z } from "zod";

import { EnvError } from "@/server/env";
import { assertNotCrossSite, handle, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { availableVoices } from "@/server/voices";

/** The voices the student can choose from in Settings (empty when speech isn't set up). */
export const GET = handle(async (request: Request) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { settings: RATE_RULES.settings });
  let voices: z.infer<typeof VoiceList>["voices"] = [];
  try {
    voices = availableVoices();
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
  }
  return NextResponse.json({ voices }, { headers: { "Cache-Control": "no-store" } });
});
