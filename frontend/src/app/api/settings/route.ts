import { SettingsPatch, UserSettings } from "@mew/shared";
import { NextResponse } from "next/server";

import {
  assertNotCrossSite,
  assertSameOrigin,
  handle,
  readJson,
  requireUserId,
} from "@/server/http";
import { rememberOptIn } from "@/server/mew-log";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

/** The signed-in student's settings (defaults filled in). */
export const GET = handle(async (request: Request) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { settings: RATE_RULES.settings });
  const settings = await userApi("/v1/me/settings", UserSettings);
  rememberOptIn(userId, settings.mew_logging_opt_in);
  return NextResponse.json(settings, { headers: { "Cache-Control": "no-store" } });
});

/** Changes some settings; returns them all. */
export const PATCH = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { settings: RATE_RULES.settings });
  const changes = await readJson(request, SettingsPatch, 2_000);
  const settings = await userApi("/v1/me/settings", UserSettings, {
    method: "PATCH",
    body: changes,
  });
  // Opting out stops logging from the next gate decision on (not after a cache expiry).
  rememberOptIn(userId, settings.mew_logging_opt_in);
  return NextResponse.json(settings);
});
