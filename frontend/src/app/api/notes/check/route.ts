import { NotebookNotesCheckRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { geminiEnv } from "@/server/env";
import { assertSameOrigin, handle, readJson, requireUserId } from "@/server/http";
import { notesCheckFailure } from "@/server/notes-check/errors";
import { runNotesCheck } from "@/server/notes-check/run";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

const MAX_BODY_BYTES = 40_000;

/**
 * A notes check started in the notebook (Notes Check): a saved clip's text against the notes,
 * from the prompt after saving a clip or a page's "Check against source" button. The student's
 * own session, so retrieval and storage run under RLS.
 */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    notesCheck: RATE_RULES.notesCheck,
    notesCheckDaily: RATE_RULES.notesCheckDaily,
    notesCheckMonthly: RATE_RULES.notesCheckMonthly,
  });
  const body = await readJson(request, NotebookNotesCheckRequest, MAX_BODY_BYTES);
  geminiEnv();

  try {
    const result = await runNotesCheck(
      {
        screen: body.screen,
        scope: body.scope,
        app: null,
        ...(body.clipId && { clipId: body.clipId }),
      },
      { kind: "student" },
      undefined,
      request.signal,
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    throw notesCheckFailure(error);
  }
});
