import { NextResponse } from "next/server";
import { z } from "zod";

import { apiFetch } from "@/server/api-client";
import { handle } from "@/server/http";
import { HttpError } from "@/server/http-error";
import { LIMITS } from "@/server/limits";
import { remove } from "@/server/redis";
import { verifySvix } from "@/server/svix";

/** Clerk's events are small; anything bigger isn't one. */
const MAX_BODY_BYTES = 64 * 1024;

const ClerkEvent = z.object({
  type: z.string(),
  data: z
    .object({
      id: z
        .string()
        .regex(/^[A-Za-z0-9_]{1,200}$/)
        .optional(),
    })
    .loose(),
});

const Empty = z.unknown();

/**
 * Clerk's webhooks (docs/LAUNCH_LIMITS.md), signed with Svix (CLERK_WEBHOOK_SECRET):
 * - `user.created`: the learner's allowance row, with all their questions.
 * - `user.deleted`: every computer they signed in on is signed out at once.
 * - `user.updated`: forget what we knew about their email (they may have just verified it).
 * `session.revoked` is ignored on purpose: the desktop app's own token isn't a browser session,
 * so signing out of a browser doesn't sign the desktop app out (the account page does that).
 */
export const POST = handle(async (request: Request) => {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, "Webhooks aren't configured");
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) throw new HttpError(413, "Too large");
  const signed = verifySvix(
    secret,
    {
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    },
    body,
  );
  if (!signed) throw new HttpError(401, "Bad signature");

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(400, "Not JSON");
  }
  const event = ClerkEvent.safeParse(parsed);
  const userId = event.success ? event.data.data.id : undefined;
  if (!event.success || !userId) return NextResponse.json({ ok: true, ignored: true });

  switch (event.data.type) {
    case "user.created":
      await apiFetch("/v1/quota/ensure", Empty, {
        method: "POST",
        body: { userId, limit: LIMITS.freeQuestions() },
      });
      break;
    case "user.deleted":
      await apiFetch("/v1/devices/revoke-user", Empty, { method: "POST", body: { userId } });
      await remove(`who:${userId}`);
      break;
    case "user.updated":
      await remove(`who:${userId}`);
      break;
    default:
      return NextResponse.json({ ok: true, ignored: true });
  }
  return NextResponse.json({ ok: true });
});
