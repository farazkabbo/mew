import { z } from "zod";

import { deviceApi, memberApi, NoContent } from "@/server/handoff";
import { device, handoffId, type IdContext, member } from "@/server/handoff-routes";
import { assertSameOrigin, handle, readJson } from "@/server/http";

const Body = z.strictObject({ type: z.enum(["opened", "walkthrough_played", "picked_up"]) });

/** What a member did (no content: a type and a time), from the page or the desktop app. */
export const POST = handle(async (request: Request, context: IdContext) => {
  const id = await handoffId(context);
  if (request.headers.get("authorization")?.startsWith("Bearer mewdt_")) {
    const who = await device(request);
    const body = await readJson(request, Body, 200);
    await deviceApi(who.token, who.email, `/v1/handoffs/${id}/device/events`, NoContent, {
      method: "POST",
      body,
    });
  } else {
    assertSameOrigin(request);
    const who = await member();
    const body = await readJson(request, Body, 200);
    await memberApi(who, `/v1/handoffs/${id}/events`, NoContent, { method: "POST", body });
  }
  return new Response(null, { status: 204 });
});
