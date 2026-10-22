import "server-only";

import { type MewDecisionResponse, type MewInput, UserSettings } from "@mew/shared";
import { after } from "next/server";
import { z } from "zod";

import { userApi } from "./user-api";

/** How long a student's opt-in answer is trusted before asking the API service again. */
const OPT_IN_TTL_MS = 60_000;
const MAX_CACHED = 10_000;

const optIns = new Map<string, { optIn: boolean; at: number }>();

/** Called when settings are read or changed through this server, so changes apply at once. */
export function rememberOptIn(userId: string, optIn: boolean, now = Date.now()): void {
  optIns.delete(userId);
  optIns.set(userId, { optIn, at: now });
  if (optIns.size > MAX_CACHED) optIns.delete(optIns.keys().next().value ?? "");
}

async function optedIn(userId: string): Promise<boolean> {
  const cached = optIns.get(userId);
  if (cached && Date.now() - cached.at < OPT_IN_TTL_MS) return cached.optIn;
  const settings = await userApi("/v1/me/settings", UserSettings);
  rememberOptIn(userId, settings.mew_logging_opt_in);
  return settings.mew_logging_opt_in;
}

const LogResult = z.object({ logged: z.boolean() });

/**
 * Keeps a gate decision for Mew v2 if, and only if, the student opted in (the API service and
 * the database check again). Never throws: logging must not affect the gate.
 */
export async function logMewDecision(
  userId: string,
  input: MewInput,
  decision: MewDecisionResponse,
): Promise<boolean> {
  try {
    if (!(await optedIn(userId))) return false;
    const { logged } = await userApi("/v1/mew/events", LogResult, {
      method: "POST",
      body: {
        input,
        output: decision.output,
        source: decision.source,
        latencyMs: Math.min(120_000, decision.latencyMs),
      },
    });
    return logged;
  } catch {
    return false;
  }
}

/** Runs `task` after the response is sent (outside a request, e.g. in tests: right away). */
export function afterResponse(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}
