import "server-only";

import {
  inLanguage,
  isRiskyLabel,
  type NebLanguage,
  renderActInput,
  SCREEN_ACT_PROMPT,
  SCREEN_LIMITS,
  ScreenActModelResponse,
  type ScreenActReply,
  type ScreenActRequest,
  unsafeReasons,
} from "@mew/shared";

import { screenModel } from "./env";
import { type GenerateStructured, generateStructured } from "./gemini";
import { HttpError } from "./http-error";
import { clipSpeech, unavailableMessage } from "./tutor";

const SCREEN_ACT_TIMEOUT_MS = 20_000;

export const SCREEN_ACT_MESSAGES = {
  unsafe: "I'll leave that one to you.",
  risky: (label: string) => `That one's yours to press: ${label}.`,
} as const;

export type ScreenActDeps = {
  generate: GenerateStructured;
  newTurnId: () => string;
};

export const screenActDeps: ScreenActDeps = {
  generate: generateStructured,
  newTurnId: () => crypto.randomUUID(),
};

/**
 * Neb's hand (packages/shared/src/screen-act.ts): the one next action for Neb's cursor, from the
 * student's goal, the screen now and what's been done so far. The desktop app performs it and
 * asks again.
 *
 * Two things turn an action into a stop here, whatever the model chose: a control whose name
 * says it buys, sends, deletes, signs in or the like (the student presses those), and anything
 * said or typed that fails the rule-based safety check every screen answer passes.
 *
 * The screenshot is forwarded to the model (`store: false`) and dropped with the request.
 */
export async function actOnScreen(
  request: ScreenActRequest,
  language: NebLanguage | undefined,
  signal?: AbortSignal,
  deps: ScreenActDeps = screenActDeps,
): Promise<ScreenActReply> {
  let made: ScreenActModelResponse;
  try {
    made = await deps.generate({
      model: screenModel(),
      purpose: "screen-act",
      system: inLanguage(SCREEN_ACT_PROMPT.system, language),
      input: [
        { type: "text" as const, text: renderActInput(request) },
        { type: "image" as const, base64: request.image.jpeg, mimeType: "image/jpeg" as const },
      ],
      schema: ScreenActModelResponse,
      thinkingLevel: "low" as const,
      maxOutputTokens: 512,
      timeoutMs: SCREEN_ACT_TIMEOUT_MS,
      ...(signal && { signal }),
    });
  } catch (error) {
    throw new HttpError(503, unavailableMessage(error));
  }
  const turnId = deps.newTurnId();
  const { action } = made;
  const said = [
    made.speech,
    ...(action.type === "type" ? [action.text] : []),
    ...(action.type === "write" ? [action.request] : []),
  ];
  const blocked = [...new Set(said.flatMap(unsafeReasons))];
  if (blocked.length > 0) {
    // Counts only: never what was said or typed.
    console.info(`[screen-act] safety check dropped an action (${blocked.join(", ")})`);
    return { speech: SCREEN_ACT_MESSAGES.unsafe, action: { type: "stop" }, turnId };
  }
  if (action.type === "click" && isRiskyLabel(action.label)) {
    return {
      speech: clipSpeech(SCREEN_ACT_MESSAGES.risky(action.label), SCREEN_LIMITS.speechChars),
      action: { type: "stop" },
      turnId,
    };
  }
  return { speech: clipSpeech(made.speech.trim(), SCREEN_LIMITS.speechChars), action, turnId };
}
