import { ClipDestinationRequest } from "@mew/shared";

import { moveClip } from "@/server/clips";
import { rememberDestination } from "@/server/destinations";
import { deviceToken, requireDevice } from "@/server/device-auth";
import { handle, readJson } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/**
 * A saved moment goes somewhere else (K3 §4.2–4.4): "Change" in the toast, the picker, or "save it
 * to …" said after it was saved. It moves (the student's notebook moves it when it reads the clip
 * again), never copied. From the desktop app (device token); FastAPI checks the token again and
 * only touches that device owner's clip.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    destinations: RATE_RULES.destinations,
    destinationsDaily: RATE_RULES.destinationsDaily,
  });
  const body = await readJson(request, ClipDestinationRequest, 4_000);
  await moveClip(deviceToken(request), body.clipId, body.destination);
  rememberDestination(device.userId, body.destination, body.source);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
});
