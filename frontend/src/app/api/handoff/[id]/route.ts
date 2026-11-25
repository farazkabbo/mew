import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiFetch } from "@/server/api-client";
import { mapApi, requireHandoff, viewFor } from "@/server/handoff";
import { handoffId, type IdContext, member, NO_STORE } from "@/server/handoff-routes";
import { assertNotCrossSite, handle, HttpError } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { isClerkConfigured } from "@/lib/auth-mode";

const Teaser = z.object({ senderFirstName: z.string() });

/**
 * A handoff for a signed-in member: its metadata, replies and content key (the sender also sees
 * who opened it). Signed out, only "A handoff from Faraz": nothing else about it.
 */
export const GET = handle(async (request: Request, context: IdContext) => {
  assertNotCrossSite(request);
  const id = await handoffId(context);
  const signedIn = !isClerkConfigured || Boolean((await auth()).userId);
  if (!signedIn) {
    if (process.env.HANDOFF_ENABLED !== "1") throw new HttpError(404, "Not found");
    const teaser = await apiFetch(`/v1/handoffs/${id}/teaser`, Teaser).catch(mapApi);
    return NextResponse.json(
      { signedIn: false, title: `A handoff from ${teaser.senderFirstName}` },
      { headers: NO_STORE },
    );
  }
  const who = await member();
  await requireHandoff(who.userId);
  enforceRateLimit(who.userId, { handoffOpen: RATE_RULES.handoffOpen });
  return NextResponse.json({ signedIn: true, ...(await viewFor(who, id)) }, { headers: NO_STORE });
});
