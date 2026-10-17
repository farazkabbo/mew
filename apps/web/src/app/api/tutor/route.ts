import { TutorRequest } from "@mew/shared";

import { geminiEnv } from "@/server/env";
import { assertSameOrigin, handle, readJson, requireUserId } from "@/server/http";
import { assertPng } from "@/server/png";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { runTutor } from "@/server/tutor";

const MAX_BODY_BYTES = 1_700_000;

/**
 * One tutor turn, streamed as newline-delimited JSON events (`speech`, then `response`) so the
 * client can start speaking before board actions finish generating.
 */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { tutor: RATE_RULES.tutor, tutorDaily: RATE_RULES.tutorDaily });
  const body = await readJson(request, TutorRequest, MAX_BODY_BYTES);
  if (body.pageImage) assertPng(body.pageImage);
  geminiEnv(); // fail fast with 503 (before streaming) when the model isn't configured

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const event of runTutor(body, request.signal)) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
});
