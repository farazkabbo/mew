import "server-only";

import { NotesRetrieval, type RetrievalScope, type ScreenTextBlock } from "@mew/shared";
import { z } from "zod";

import { ApiError, apiFetch } from "../api-client";
import { HttpError } from "../http-error";
import { userApi } from "../user-api";

/**
 * Notes Check's calls to the API service, as whoever asked: the signed-in student (their Clerk
 * session, so RLS applies) or the desktop app (its device token, checked there again).
 */
export type Asker = { kind: "student" } | { kind: "device"; token: string };

export const CheckCreated = z.object({
  checkId: z.uuid(),
  findingIds: z.array(z.uuid().nullable()),
});
export type CheckCreated = z.infer<typeof CheckCreated>;

/** What's stored of one finding (snake-free camelCase, as the API reads it). */
export type FindingToStore = {
  type: string;
  noteLineIds: string[];
  anchorLineId?: string;
  noteQuote?: string;
  screenSnippet: string;
  question?: string;
  explanation: string;
  conceptHint?: string;
  confidence: number;
  sourceConflict: boolean;
};

export type CheckToStore = {
  scope: NotesRetrieval["scope"];
  sourceApp: string | null;
  modelVersion: string;
  latencyMs: number;
  findings: FindingToStore[];
  links: {
    noteLineId: string;
    finding: number;
    clipId?: string;
    url?: string;
    title?: string;
    timestampSec?: number;
  }[];
};

export async function retrieveNotes(
  asker: Asker,
  screen: readonly ScreenTextBlock[],
  scope: RetrievalScope,
  excludeClipId?: string,
): Promise<NotesRetrieval> {
  const body = { screen, scope, ...(excludeClipId && { excludeClipId }) };
  if (asker.kind === "student") {
    return userApi("/v1/notes/retrieve", NotesRetrieval, {
      method: "POST",
      body,
      timeoutMs: 10_000,
    });
  }
  return deviceCall("/v1/notes/device/retrieve", NotesRetrieval, asker.token, body);
}

export async function saveCheck(asker: Asker, check: CheckToStore): Promise<CheckCreated> {
  if (asker.kind === "student") {
    return userApi("/v1/notes/checks", CheckCreated, {
      method: "POST",
      body: check,
      timeoutMs: 10_000,
    });
  }
  return deviceCall("/v1/notes/device/checks", CheckCreated, asker.token, check);
}

async function deviceCall<T>(
  path: `/${string}`,
  schema: z.ZodType<T>,
  token: string,
  body: unknown,
): Promise<T> {
  try {
    return await apiFetch(path, schema, {
      method: "POST",
      body,
      headers: { "X-Mew-Device-Token": token },
      timeoutMs: 10_000,
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 401) throw new HttpError(401, "Unauthorized");
    if (error.status === null || error.status === 503) {
      throw new HttpError(503, "Notes Check isn't available right now");
    }
    throw new HttpError(502, "Notes Check failed");
  }
}
