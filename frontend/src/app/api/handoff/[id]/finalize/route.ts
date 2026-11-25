import { deviceApi, NoContent } from "@/server/handoff";
import { device, handoffId, type IdContext } from "@/server/handoff-routes";
import { handle } from "@/server/http";

/**
 * Sends a draft whose ciphertext is uploaded. The recipient sees it in their inbox (email
 * notifications aren't wired yet: docs/HANDOFF_FEATURE.md decision 5).
 */
export const POST = handle(async (request: Request, context: IdContext) => {
  const who = await device(request);
  await deviceApi(who.token, null, `/v1/handoffs/${await handoffId(context)}/finalize`, NoContent, {
    method: "POST",
  });
  return new Response(null, { status: 204 });
});
