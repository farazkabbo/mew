import { DestinationResolveRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { deviceTree, resolveForUser } from "@/server/destinations";
import { deviceToken, requireDevice } from "@/server/device-auth";
import { handle, readJson } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/**
 * "Save this to Chemistry chapter 2" said or typed in Screen Coach without a question, or after an
 * explanation (K3 §4.2): where those words go in the student's own notebooks. From the desktop app
 * (device token). The answer is a place, chips to choose from, a chapter to offer to create, or
 * none; nothing is made here.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    destinations: RATE_RULES.destinations,
    destinationsDaily: RATE_RULES.destinationsDaily,
  });
  const { phrase } = await readJson(request, DestinationResolveRequest, 4_000);
  const nodes = await deviceTree(deviceToken(request));
  const resolution = await resolveForUser(device.userId, phrase, nodes);
  return NextResponse.json({ resolution }, { headers: { "Cache-Control": "no-store" } });
});
