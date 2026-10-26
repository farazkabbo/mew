import { z } from "zod";

import {
  assertNotCrossSite,
  assertSameOrigin,
  handle,
  HttpError,
  readBytes,
  requireUserId,
} from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi, userApiBytes } from "@/server/user-api";

type Context = { params: Promise<{ clipId: string; turn: string; step: string }> };

/** One step's voice: about 20 s of 16-bit PCM at 24 kHz at most. */
const MAX_PCM_BYTES = 1_000_000;
const PCM = "audio/L16";

const Params = z.object({
  clipId: z.uuid(),
  turn: z.coerce.number().int().min(0).max(2),
  step: z.coerce.number().int().min(0).max(4),
});

async function where(context: Context): Promise<`/${string}`> {
  const params = Params.safeParse(await context.params);
  if (!params.success) throw new HttpError(404, "Not found");
  const { clipId, turn, step } = params.data;
  return `/v1/moments/${clipId}/audio/${turn}/${step}`;
}

/**
 * A moment's own voice (K8 §4.7: "Replay … with the original voice"): the page uploads each step
 * it played, as it played it, so a replay costs nothing and sounds the same. Kept in the
 * student's own folder of a private bucket, with their session.
 */
export const PUT = handle(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    momentAudio: RATE_RULES.momentAudio,
    momentAudioDaily: RATE_RULES.momentAudioDaily,
  });
  const path = await where(context);
  const pcm = await readBytes(request, PCM.toLowerCase(), MAX_PCM_BYTES);
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) throw new HttpError(400, "Invalid audio");
  await userApi(path, z.undefined(), {
    method: "PUT",
    raw: { data: pcm, contentType: PCM },
    timeoutMs: 15_000,
  });
  return new Response(null, { status: 204 });
});

export const GET = handle(async (request: Request, context: Context) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { momentRead: RATE_RULES.momentRead });
  const { bytes, contentType } = await userApiBytes(await where(context));
  if (!contentType.toLowerCase().startsWith("audio/l16")) {
    throw new HttpError(502, "Unexpected audio");
  }
  return new Response(bytes, {
    headers: {
      "Content-Type": PCM,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
