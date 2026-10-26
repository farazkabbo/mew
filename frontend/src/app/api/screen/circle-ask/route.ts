import { CircleAskRequest } from "@mew/shared";

import { runCircleAsk } from "@/server/circle-ask";
import { circleDestination } from "@/server/destinations";
import { deviceToken, requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { handle, readJson } from "@/server/http";
import { assertJpeg } from "@/server/jpeg";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** Two base64 JPEGs (~1 MB each at most), the marks and a little text. */
const MAX_BODY_BYTES = 3_000_000;

/**
 * Circle & Ask (S3.2): the student marked something on screen and asked about it, from the desktop
 * app (device token). Streams newline-delimited JSON events: each `step` as soon as it's written
 * and checked, then `done` (or `abort` when a step fails the safety check). The two images were
 * captured and redacted on the device; they're forwarded to the model and dropped with the
 * request, never stored or logged.
 *
 * "…and save it to Physics chapter 5" (K3) is taken out of the question first, resolved against
 * the student's own notebooks, and sent as a `destination` event before any step.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    circleAsk: RATE_RULES.circleAsk,
    circleAskDaily: RATE_RULES.circleAskDaily,
    circleAskMonthly: RATE_RULES.circleAskMonthly,
  });
  const body = await readJson(request, CircleAskRequest, MAX_BODY_BYTES);
  assertJpeg(body.focus.image.jpeg);
  assertJpeg(body.context.jpeg);
  geminiEnv(); // 503 before streaming when the model isn't configured
  const placed = await circleDestination(body, device.userId, deviceToken(request));

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (placed.event) controller.enqueue(encoder.encode(`${JSON.stringify(placed.event)}\n`));
      for await (const event of runCircleAsk(placed.request, request.signal)) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
});
