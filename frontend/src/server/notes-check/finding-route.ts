import "server-only";

import { z } from "zod";

import { geminiEnv } from "../env";
import { assertSameOrigin, HttpError, requireUserId } from "../http";
import { enforceRateLimit, RATE_RULES } from "../rate-limit";
import { notesCheckFailure } from "./errors";

export type FindingContext = { params: Promise<{ id: string }> };

/**
 * The common start of every "resolve a finding" route: same origin, signed in, within the rate
 * limits, a finding id that is a UUID (anything else is simply not found), and a model when the
 * work needs one. Failures of the work itself become safe HTTP errors.
 */
export async function findingAction<T>(
  request: Request,
  context: FindingContext,
  work: (findingId: string) => Promise<T>,
  { model = true }: { model?: boolean } = {},
): Promise<T> {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    notesResolve: RATE_RULES.notesResolve,
    notesResolveDaily: RATE_RULES.notesResolveDaily,
  });
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) throw new HttpError(404, "Not found");
  if (model) geminiEnv(); // 503 before any work when the model isn't configured
  try {
    return await work(id.data);
  } catch (error) {
    throw notesCheckFailure(error);
  }
}
