import { ScreenAskRequest } from "@mew/shared";

import { walkthroughContext } from "@/server/coach/run";
import { deviceWalkthroughs } from "@/server/coach/store";
import { deviceToken, requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { handle, readJson } from "@/server/http";
import { assertJpeg } from "@/server/jpeg";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { screenCourseContext } from "@/server/screen-course";
import { runScreenTutor } from "@/server/screen-tutor";

/** The JSON body: a base64 JPEG (~1 MB at most) plus a short question. */
const MAX_BODY_BYTES = 1_500_000;

/**
 * Screen Coach: one question about the student's screen, from the desktop app (device token;
 * no browser session). Streams newline-delimited JSON events (`speech`, then `response`) so the
 * desktop app can start speaking before the ink actions finish generating.
 *
 * The screenshot was captured and redacted on the device; here it is checked, forwarded to the
 * model, and dropped with the request. It is never stored or logged. A question asked during a
 * walkthrough (coach mode) is answered in its context, and the student's own course passages
 * about the question come with it (S5), so the answer can name the connection.
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
  // Asked in the middle of a walkthrough: the tutor answers about its current step.
  const token = deviceToken(request);
  const [walkthrough, courseContext] = await Promise.all([
    body.walkthroughId
      ? walkthroughContext(deviceWalkthroughs(token), body.walkthroughId)
      : undefined,
    screenCourseContext(token, body.transcript),
  ]);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const event of runScreenTutor(
        { ...body, ...(walkthrough && { walkthrough }), courseContext },
        request.signal,
      )) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
});
