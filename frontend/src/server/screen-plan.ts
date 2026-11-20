import "server-only";

import {
  inLanguage,
  type NebLanguage,
  planForMode,
  renderPlanInput,
  SCREEN_LIMITS,
  SCREEN_PLAN_PROMPT,
  ScreenPlanModelResponse,
  type ScreenPlanReply,
  type ScreenPlanRequest,
  unsafeReasons,
} from "@mew/shared";

import { screenModel } from "./env";
import { type GenerateStructured, generateStructured } from "./gemini";
import { HttpError } from "./http-error";
import { clipSpeech, unavailableMessage } from "./tutor";

const SCREEN_PLAN_TIMEOUT_MS = 15_000;

/** A lesson's re-plans belong to the question that started it (a follow-up group). */
export const planKey = (planId: string) => `q:plan:${planId}`;

export const SCREEN_PLAN_MESSAGES = {
  unsafe: "I'll leave that one to you.",
} as const;

export type ScreenPlanDeps = {
  generate: GenerateStructured;
  newPlanId: () => string;
  today: () => string;
};

export const screenPlanDeps: ScreenPlanDeps = {
  generate: generateStructured,
  newPlanId: () => crypto.randomUUID(),
  today: () => new Date().toISOString().slice(0, 10),
};

/**
 * Plans a SHOW ME lesson or picks a DO IT action (packages/shared/src/screen-plan.ts) from the
 * student's words and the window's control names. No screenshot ever comes here. What's said
 * passes the rule-based safety check every screen answer passes; a plan that fails it is
 * dropped. The desktop app checks the reply again before anything happens.
 */
export async function planForScreen(
  request: ScreenPlanRequest,
  language: NebLanguage | undefined,
  planId: string | undefined,
  signal?: AbortSignal,
  deps: ScreenPlanDeps = screenPlanDeps,
): Promise<ScreenPlanReply> {
  let made: ScreenPlanModelResponse;
  try {
    made = await deps.generate({
      model: screenModel(),
      purpose: "screen-plan",
      system: inLanguage(SCREEN_PLAN_PROMPT.system, language),
      input: [{ type: "text" as const, text: renderPlanInput(request, deps.today()) }],
      schema: ScreenPlanModelResponse,
      thinkingLevel: "low" as const,
      maxOutputTokens: 1024,
      timeoutMs: SCREEN_PLAN_TIMEOUT_MS,
      ...(signal && { signal }),
    });
  } catch (error) {
    throw new HttpError(503, unavailableMessage(error));
  }
  const id = planId ?? deps.newPlanId();
  const said = [made.speech, ...made.steps.map((s) => s.name)];
  const blocked = [...new Set(said.flatMap(unsafeReasons))];
  if (blocked.length > 0) {
    // Counts only: never what was said.
    console.info(`[screen-plan] safety check dropped a plan (${blocked.join(", ")})`);
    return { planId: id, speech: SCREEN_PLAN_MESSAGES.unsafe, steps: [], action: null };
  }
  return {
    planId: id,
    speech: clipSpeech(made.speech.trim(), SCREEN_LIMITS.speechChars),
    ...planForMode(request.mode, made),
  };
}
