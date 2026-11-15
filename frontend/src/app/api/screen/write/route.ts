import { ScreenWriteRequest } from "@mew/shared";

import { requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { handle, readJson } from "@/server/http";
import { assertJpeg } from "@/server/jpeg";
import { requireAllowance } from "@/server/question-gate";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { writeForScreen } from "@/server/screen-write";

/** The JSON body: a base64 JPEG (~1 MB at most) plus what the student said. */
const MAX_BODY_BYTES = 1_500_000;

/**
 * Typing into a document ("write an essay on cats", "rewrite this sentence"), from the desktop
 * app (device token). Streams newline-delimited JSON events (`start`, then `text` pieces as the
 * model writes them, then `done`; or `error`), so the desktop app starts typing within a second
 * or two. The desktop types it; this route only writes it. The screenshot was captured and
 * redacted on the device; it is forwarded to the model and dropped with the request, never
 * stored or logged.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  await requireAllowance(device.userId);
  enforceRateLimit(device.userId, {
    screenWrite: RATE_RULES.screenWrite,
    screenWriteDaily: RATE_RULES.screenWriteDaily,
    screenMonthly: RATE_RULES.screenMonthly,
  });
  const body = await readJson(request, ScreenWriteRequest, MAX_BODY_BYTES);
  assertJpeg(body.image.jpeg);
  geminiEnv(); // fail fast with 503 (before streaming) when the model isn't configured

  const encoder = new TextEncoder();
  const events = writeForScreen(body, device.language, request.signal);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await events.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await events.return(undefined);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Proxies must pass each line on as it's written.
      "X-Accel-Buffering": "no",
    },
  });
});
