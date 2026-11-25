import "server-only";

import { z } from "zod";

import { deviceToken, requireDevice } from "./device-auth";
import { currentMember, type Member, requireHandoff } from "./handoff";
import { HttpError } from "./http-error";
import { requireUserId } from "./http";
import { learnerFacts } from "./learner-identity";

export type IdContext = { params: Promise<{ id: string }> };

const Id = z.uuid();

/** The handoff id from the route, strictly a uuid (deep links and paths alike). */
export async function handoffId(context: IdContext): Promise<string> {
  const parsed = Id.safeParse((await context.params).id);
  if (!parsed.success) throw new HttpError(404, "Not found");
  return parsed.data;
}

/** A signed-in member (Clerk), with Handoff on for them. */
export async function member(): Promise<Member> {
  const userId = await requireUserId();
  await requireHandoff(userId);
  return currentMember(userId);
}

/** The desktop app (device token), with Handoff on for its owner, and the owner's verified email. */
export async function device(request: Request) {
  const verified = await requireDevice(request);
  await requireHandoff(verified.userId);
  const facts = await learnerFacts(verified.userId).catch(() => null);
  const token = deviceToken(request);
  return { ...verified, token, email: facts?.verified ? facts.email : null };
}

export const NO_STORE = { "Cache-Control": "no-store" } as const;
