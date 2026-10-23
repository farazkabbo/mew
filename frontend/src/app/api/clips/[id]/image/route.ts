import { assertNotCrossSite, handle, HttpError, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApiBytes } from "@/server/user-api";

import { clipId } from "../route";

type Context = { params: Promise<{ id: string }> };

/**
 * A saved clip's image, for its owner's notebook page. Served from our own origin (so the page's
 * CSP needn't allow the storage host) and read with the student's session, so RLS and the
 * bucket's per-user policy apply. Never cached: it's the student's screen.
 */
export const GET = handle(async (request: Request, context: Context) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { clipRead: RATE_RULES.clipRead });
  const { bytes, contentType } = await userApiBytes(`/v1/clips/${await clipId(context)}/image`);
  if (contentType !== "image/jpeg") throw new HttpError(502, "Unexpected image");
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // Opened on its own, it's a picture and nothing else.
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
});
