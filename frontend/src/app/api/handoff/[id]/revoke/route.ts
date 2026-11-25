import { memberApi, NoContent } from "@/server/handoff";
import { handoffId, type IdContext, member } from "@/server/handoff-routes";
import { assertSameOrigin, handle } from "@/server/http";

/** The sender revokes it: the link stops working at once and the package is deleted. */
export const POST = handle(async (request: Request, context: IdContext) => {
  assertSameOrigin(request);
  const who = await member();
  await memberApi(who, `/v1/handoffs/${await handoffId(context)}/revoke`, NoContent, {
    method: "POST",
  });
  return new Response(null, { status: 204 });
});
