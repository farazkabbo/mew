import { MewEventPage } from "@mew/shared";

import { assertNotCrossSite, handle, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi } from "@/server/user-api";

/**
 * The student's labelled decisions as JSONL, ready for the dataset exporter
 * (`python -m mew_api.dataset --jsonl …`).
 */
export const GET = handle(async (request: Request) => {
  assertNotCrossSite(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, { mewEvents: RATE_RULES.mewEvents });
  const { events } = await userApi("/v1/mew/events/labeled", MewEventPage);
  const lines = events.map((e) =>
    JSON.stringify({ input: e.input, human_label: e.human_label, created_at: e.created_at }),
  );
  return new Response(lines.join("\n") + (lines.length ? "\n" : ""), {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": 'attachment; filename="mew-labels.jsonl"',
      "Cache-Control": "no-store",
    },
  });
});
