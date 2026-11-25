import { HANDOFF_LIMITS } from "@mew/shared";

import { deviceApi, memberPackage, NoContent } from "@/server/handoff";
import { device, handoffId, type IdContext, member } from "@/server/handoff-routes";
import { assertNotCrossSite, handle, readBytes } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** The sender's desktop app uploads the ciphertext (nothing else is ever stored). */
export const PUT = handle(async (request: Request, context: IdContext) => {
  const who = await device(request);
  const id = await handoffId(context);
  const data = await readBytes(request, "application/octet-stream", HANDOFF_LIMITS.packageBytes);
  await deviceApi(who.token, null, `/v1/handoffs/${id}/package`, NoContent, {
    method: "PUT",
    raw: { data, contentType: "application/octet-stream" },
  });
  return new Response(null, { status: 204 });
});

/** The desktop app's HTTP client only posts: the same upload. */
export const POST = PUT;

/** A member downloads the ciphertext; it's decrypted in their browser with the key from GET. */
export const GET = handle(async (request: Request, context: IdContext) => {
  assertNotCrossSite(request);
  const who = await member();
  enforceRateLimit(who.userId, { handoffOpen: RATE_RULES.handoffOpen });
  const bytes = await memberPackage(who, await handoffId(context));
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
