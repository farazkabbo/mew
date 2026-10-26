import { ClipCreateRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { assertClip, createClip, MAX_CLIP_BODY_BYTES } from "@/server/clips";
import { rememberDestination } from "@/server/destinations";
import { deviceToken, requireDevice } from "@/server/device-auth";
import { handle, readJson } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/**
 * Screen Coach S3: a clip the student saved in the desktop app's preview (device token; no
 * browser session). The image was captured and redacted on the device; here it is checked and
 * stored privately for its owner. The reply is only the new clip's id: the student's signed-in
 * page reads the clip back to build its notebook page.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, { clip: RATE_RULES.clip, clipDaily: RATE_RULES.clipDaily });
  const clip = await readJson(request, ClipCreateRequest, MAX_CLIP_BODY_BYTES);
  assertClip(clip);
  const created = await createClip(deviceToken(request), clip);
  // Its place becomes this source's sticky one (and a recent one) for the next save (K3).
  if (clip.destination) rememberDestination(device.userId, clip.destination, clip.source);
  return NextResponse.json(created, { status: 201, headers: { "Cache-Control": "no-store" } });
});
