import { z } from "zod";

import { assertSameOrigin, handle, HttpError, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

type Context = { params: Promise<{ id: string }> };

/** Forgets a skill and its evidence (the walkthroughs themselves stay, as history). */
export const DELETE = handle(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { courseRead: RATE_RULES.courseRead });
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) throw new HttpError(404, "Not found");
  await userApi(`/v1/skills/${id.data}`, z.undefined(), { method: "DELETE" });
  return new Response(null, { status: 204 });
});
