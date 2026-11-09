import "server-only";

import { clerkClient } from "@clerk/nextjs/server";

import { LOCAL_USER_ID } from "@/lib/auth-mode";

import { HttpError } from "./http-error";
import { getJson, setJson } from "./redis";

/** How long a learner's email facts are trusted before asking Clerk again. */
const KEPT_S = 10 * 60;

export type LearnerFacts = { verified: boolean; email: string | null };

/**
 * What the question gate needs to know about a learner, from Clerk (docs/LAUNCH_LIMITS.md): is
 * their primary email verified, and what is it (for the founders' allowlist). Kept in Redis
 * briefly, never the email in a log. Local mode (no Clerk) is verified, with no email.
 */
export async function learnerFacts(userId: string): Promise<LearnerFacts> {
  if (userId === LOCAL_USER_ID) return { verified: true, email: null };
  const key = `who:${userId}`;
  const kept = await getJson<LearnerFacts>(key);
  if (kept) return kept;
  const user = await (await clerkClient()).users.getUser(userId).catch(() => null);
  if (!user) throw new HttpError(401, "Unauthorized");
  const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
  const facts: LearnerFacts = {
    verified: primary?.verification?.status === "verified",
    email: primary?.emailAddress.toLowerCase() ?? null,
  };
  await setJson(key, facts, KEPT_S);
  return facts;
}

/** 403 EMAIL_UNVERIFIED unless the learner's primary email is verified. */
export function requireVerified(facts: LearnerFacts): void {
  if (!facts.verified) {
    throw new HttpError(
      403,
      "Confirm your email address first, then ask again.",
      {},
      "EMAIL_UNVERIFIED",
    );
  }
}
