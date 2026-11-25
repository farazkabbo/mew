import { HandoffInbox } from "@mew/shared";
import { NextResponse } from "next/server";

import { memberApi, NoContent } from "@/server/handoff";
import { member, NO_STORE } from "@/server/handoff-routes";
import { assertNotCrossSite, assertSameOrigin, handle } from "@/server/http";

/** The inbox: handoffs received and sent, with where each one is at. */
export const GET = handle(async (request: Request) => {
  assertNotCrossSite(request);
  const who = await member();
  return NextResponse.json(await memberApi(who, "/v1/handoffs", HandoffInbox), {
    headers: NO_STORE,
  });
});

/** "Delete my handoff history": everything sent and received, for good. */
export const DELETE = handle(async (request: Request) => {
  assertSameOrigin(request);
  const who = await member();
  await memberApi(who, "/v1/handoffs", NoContent, { method: "DELETE" });
  return new Response(null, { status: 204 });
});
