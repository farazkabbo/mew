import { ClipCreateRequest, unsortedNodeId } from "@mew/shared";
import { NextResponse } from "next/server";

import { assertClip, createClip, MAX_CLIP_BODY_BYTES } from "@/server/clips";
import { rememberDestination } from "@/server/destinations";
import { deviceToken, requireDevice } from "@/server/device-auth";
import { withServerExtras } from "@/server/entry-extras";
import { fileMoment, savedDestination } from "@/server/filing";
import { handle, readJson } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/**
 * Screen Coach S3: a clip the student saved in the desktop app's preview (device token; no
 * browser session). The image was captured and redacted on the device; here it is checked and
 * stored privately for its owner. The reply is only the new clip's id: the student's signed-in
 * page reads the clip back to build its notebook page.
 *
 * An entry gets what this server worked out about its session (K7's verified solution, K8's
 * subject and check question), never the device's own. Saved without a place, it's filed by what
 * it's about (K8 §4.6) instead of going to whichever notebook happens to be open.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, { clip: RATE_RULES.clip, clipDaily: RATE_RULES.clipDaily });
  const body = await readJson(request, ClipCreateRequest, MAX_CLIP_BODY_BYTES);
  assertClip(body);
  const token = deviceToken(request);
  const entry = body.entry && withServerExtras(body.entry, device.userId);
  const source = { app: body.source.app, title: body.source.title, url: body.source.url };
  const filed = body.destination
    ? null
    : await fileMoment(token, {
        userId: device.userId,
        source,
        subject: entry?.moment?.subject ?? null,
        hints: entry?.conceptHints ?? [],
      });
  const destination = body.destination ?? (filed ? savedDestination(filed) : undefined);
  const clip: ClipCreateRequest = {
    ...body,
    ...(entry && { entry }),
    ...(destination && { destination }),
  };
  const created = await createClip(token, clip);
  // Its place becomes this source's sticky one (and a recent one) for the next save (K3); not
  // Unsorted, which is where things wait, not where they belong.
  if (clip.destination && clip.destination.nodeId !== unsortedNodeId(device.userId)) {
    rememberDestination(device.userId, clip.destination, clip.source);
  }
  return NextResponse.json(created, { status: 201, headers: { "Cache-Control": "no-store" } });
});
