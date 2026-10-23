import { NotePageSync, NotePageSyncResult } from "@mew/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { assertSameOrigin, handle, HttpError, readJson, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi, type UserApiMessages } from "@/server/user-api";

/** 200 lines of at most ~800 bytes each, plus the notebook. */
const MAX_BODY_BYTES = 200_000;

const MESSAGES: UserApiMessages = {
  unavailable: "Notes can't be saved for checking right now",
  notConfigured: "Notes Check isn't configured on the server",
  passThrough: new Map([
    [400, "That request wasn't valid"],
    [403, "Notes Check's copy of your notes is turned off"],
    [422, "That request wasn't valid"],
  ]),
  failed: "Notes couldn't be saved for checking",
};

type Context = { params: Promise<{ pageId: string }> };

/**
 * Notes Check (N1): the recognised text of one notebook page's lines, synced after the page
 * changed: lines added or changed, and lines removed. Sent with the student's own session, so
 * the database applies RLS and the notes_index setting.
 */
export const PUT = handle(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    notesSync: RATE_RULES.notesSync,
    notesSyncDaily: RATE_RULES.notesSyncDaily,
  });
  const pageId = z.uuid().safeParse((await context.params).pageId);
  if (!pageId.success) throw new HttpError(404, "Not found");
  const body = await readJson(request, NotePageSync, MAX_BODY_BYTES);

  const result = await userApi(
    `/v1/notes/pages/${pageId.data}/lines`,
    NotePageSyncResult,
    // The API embeds the lines whose text changed before it answers.
    { method: "PUT", body, timeoutMs: 15_000 },
    MESSAGES,
  );
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
});
