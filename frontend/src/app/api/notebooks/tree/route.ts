import { NotebookTreeSync, NotebookTreeSyncResult, NotebookTreeView } from "@mew/shared";
import { NextResponse } from "next/server";

import { assertSameOrigin, handle, readJson, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { userApi, type UserApiMessages } from "@/server/user-api";

/** 200 nodes of at most ~500 bytes each, plus the purged ids. */
const MAX_BODY_BYTES = 150_000;

const MESSAGES: UserApiMessages = {
  unavailable: "Your notebooks can't be synced right now",
  notConfigured: "Notebook sync isn't configured on the server",
  passThrough: new Map([
    [400, "That request wasn't valid"],
    [422, "That request wasn't valid"],
  ]),
  failed: "Your notebooks couldn't be synced",
};

const LIMITS = { notebookTree: RATE_RULES.notebookTree, daily: RATE_RULES.notebookTreeDaily };

/**
 * The notebook tree (K1, docs/NOTEBOOKS_K.md §2.4): the student's notebooks, chapters and
 * sections (titles and places only, never page content), with their own session, so the
 * database applies RLS and the tree rules.
 */
export const GET = handle(async () => {
  const userId = await requireUserId();
  enforceRateLimit(userId, LIMITS);
  const tree = await userApi("/v1/notebooks/tree", NotebookTreeView, {}, MESSAGES);
  return NextResponse.json(tree, { headers: { "Cache-Control": "no-store" } });
});

/** The device's changes; each node comes back saved, renamed, stale or rejected. */
export const PUT = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, LIMITS);
  const body = await readJson(request, NotebookTreeSync, MAX_BODY_BYTES);
  const result = await userApi(
    "/v1/notebooks/tree",
    NotebookTreeSyncResult,
    { method: "PUT", body },
    MESSAGES,
  );
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
});
