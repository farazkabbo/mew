import "server-only";

import {
  renderIntentInput,
  SCREEN_INTENT_PROMPT,
  ScreenIntentReply,
  type ScreenIntentRequest,
} from "@mew/shared";

import { screenModel } from "./env";
import { type GenerateStructured, generateStructured } from "./gemini";
import { HttpError } from "./http-error";
import { unavailableMessage } from "./tutor";

/** Short: the desktop app waits for this before doing anything, and has its own rules to fall back on. */
const SCREEN_INTENT_TIMEOUT_MS = 4_000;

export type ScreenIntentDeps = { generate: GenerateStructured };

export const screenIntentDeps: ScreenIntentDeps = { generate: generateStructured };

/**
 * What the student meant by what they said to Screen Coach: a question, typing into their
 * document, saving, a walkthrough… (packages/shared/src/screen-intent.ts). Words only: no
 * screenshot comes here. Answers that don't fit what Neb is doing are turned into a question.
 */
export async function intentForScreen(
  request: ScreenIntentRequest,
  signal?: AbortSignal,
  deps: ScreenIntentDeps = screenIntentDeps,
): Promise<ScreenIntentReply> {
  let made: ScreenIntentReply;
  try {
    made = await deps.generate({
      model: screenModel(),
      purpose: "screen-intent",
      system: SCREEN_INTENT_PROMPT.system,
      input: [{ type: "text" as const, text: renderIntentInput(request) }],
      schema: ScreenIntentReply,
      thinkingLevel: "minimal" as const,
      maxOutputTokens: 64,
      timeoutMs: SCREEN_INTENT_TIMEOUT_MS,
      ...(signal && { signal }),
    });
  } catch (error) {
    throw new HttpError(503, unavailableMessage(error));
  }
  const { intent } = made;
  // A walkthrough's replies only mean something during one; "show that again" needs ink.
  const stray =
    (intent.startsWith("coach_") &&
      !["coach_start", "coach_resume", "coach_recheck"].includes(intent) &&
      !request.coaching) ||
    (intent === "reannotate" && !request.hasInk);
  return { intent: stray ? "ask" : intent };
}
