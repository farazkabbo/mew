import { ScreenAskRequest } from "@mew/shared";

import { requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { handle, readJson } from "@/server/http";
import { assertJpeg } from "@/server/jpeg";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { runScreenTutor } from "@/server/screen-tutor";

/** The JSON body: a base64 JPEG (~1 MB at most) plus a short question. */
const MAX_BODY_BYTES = 1_500_000;

/**
 * Screen Coach: one question about the student's screen, from the desktop app (device token;
 * no browser session). Streams newline-delimited JSON events (`speech`, then `response`) so the
 * desktop app can start speaking before the ink actions finish generating.
 *
 * The screenshot was captured and redacted on the device; here it is checked, forwarded to the
 * model, and dropped with the request. It is never stored or logged.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    screen: RATE_RULES.screen,
    screenDaily: RATE_RULES.screenDaily,
    screenMonthly: RATE_RULES.screenMonthly,
  });
  const body = await readJson(request, ScreenAskRequest, MAX_BODY_BYTES);
  assertJpeg(body.image.jpeg);
  geminiEnv(); // fail fast with 503 (before streaming) when the model isn't configured

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const event of runScreenTutor(body, request.signal)) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
});
