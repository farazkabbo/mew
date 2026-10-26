import { MomentMove } from "@mew/shared";
import { z } from "zod";

import { assertSameOrigin, handle, HttpError, readJson, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

type Context = { params: Promise<{ clipId: string }> };

const MAX_BODY_BYTES = 1_000;

/**
 * A moment filed from the notebook (K8): moved there, or a "File these" suggestion accepted. The
 * notebook has already moved it on this device; the server's copy follows (other devices put it
 * there too), its check goes with it, and filing learns from it like "Change".
 */
export const POST = handle(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    momentFile: RATE_RULES.momentFile,
    momentFileDaily: RATE_RULES.momentFileDaily,
  });
  const clipId = z.uuid().safeParse((await context.params).clipId);
  if (!clipId.success) throw new HttpError(404, "Not found");
  const body = await readJson(request, MomentMove, MAX_BODY_BYTES);
  await userApi(`/v1/clips/${clipId.data}/move`, z.undefined(), { method: "POST", body });
  return new Response(null, { status: 204 });
});
