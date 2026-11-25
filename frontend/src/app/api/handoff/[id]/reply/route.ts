import { HANDOFF_LIMITS } from "@mew/shared";
import { currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { isClerkConfigured } from "@/lib/auth-mode";
import { memberApi } from "@/server/handoff";
import { handoffId, type IdContext, member, NO_STORE } from "@/server/handoff-routes";
import { assertSameOrigin, handle, readJson } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

const Body = z.strictObject({ body: z.string().trim().min(1).max(HANDOFF_LIMITS.replyChars) });
const Reply = z.object({
  id: z.uuid(),
  authorName: z.string(),
  body: z.string(),
  createdAt: z.string(),
  mine: z.boolean(),
});

/** A short reply to the sender, threaded on the handoff (a neb account is needed: signed in). */
export const POST = handle(async (request: Request, context: IdContext) => {
  assertSameOrigin(request);
  const who = await member();
  enforceRateLimit(who.userId, { handoffReply: RATE_RULES.handoffReply });
  const { body } = await readJson(request, Body, 4_000);
  const user = isClerkConfigured ? await currentUser() : null;
  const authorName = (user?.firstName || user?.username || "Your teammate").slice(0, 80);
  const reply = await memberApi(who, `/v1/handoffs/${await handoffId(context)}/replies`, Reply, {
    method: "POST",
    body: { authorName, body },
  });
  return NextResponse.json(reply, { status: 201, headers: NO_STORE });
});
