import { NextResponse } from "next/server";

import { deviceTree, placesOf } from "@/server/destinations";
import { deviceToken, requireDevice } from "@/server/device-auth";
import { handle } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/**
 * Screen Coach's destination picker (K3 §4.4, "Change" and Ctrl+D): every notebook, chapter and
 * section the student has, as their titles from the notebook down. From the desktop app (device
 * token, so a POST with an empty body: the app's HTTP client only posts); titles only, never page
 * content. At most 200 places, titles cut to 80 characters, so the reply is one small line.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    destinations: RATE_RULES.destinations,
    destinationsDaily: RATE_RULES.destinationsDaily,
  });
  const places = placesOf(await deviceTree(deviceToken(request)))
    .slice(0, 200)
    .map((place) => ({ ...place, path: place.path.map((title) => title.slice(0, 80)) }));
  return NextResponse.json({ places }, { headers: { "Cache-Control": "no-store" } });
});
