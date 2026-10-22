import { TelemetryBatch } from "@mew/shared";
import { NextResponse } from "next/server";

import {
  assertNotCrossSite,
  assertSameOrigin,
  handle,
  readJson,
  requireUserId,
} from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { latencyLog } from "@/server/telemetry";

/** Records the timings of recent tutor turns (no content). */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { telemetry: RATE_RULES.telemetry });
  const { turns } = await readJson(request, TelemetryBatch, 8_000);
  latencyLog.record(userId, turns);
  return new NextResponse(null, { status: 204 });
});

/** The caller's recent latency: median and 95th percentile per stage. */
export const GET = handle(async (request: Request) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { telemetryRead: RATE_RULES.telemetryRead });
  return NextResponse.json(latencyLog.report(userId), {
    headers: { "Cache-Control": "no-store" },
  });
});
