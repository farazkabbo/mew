import "server-only";

import {
  checkScreenReply,
  inLanguage,
  type NebLanguage,
  renderWatchInput,
  SCREEN_LIMITS,
  SCREEN_WATCH_PROMPT,
  ScreenWatchModelResponse,
  type ScreenWatchReply,
  type ScreenWatchRequest,
  withFocusRegion,
} from "@mew/shared";

import { screenModel } from "./env";
import { type GenerateStructured, generateStructured } from "./gemini";
import { HttpError } from "./http-error";
import { clipSpeech, unavailableMessage } from "./tutor";

const SCREEN_WATCH_TIMEOUT_MS = 15_000;

export type ScreenWatchDeps = {
  generate: GenerateStructured;
  newTurnId: () => string;
};

export const screenWatchDeps: ScreenWatchDeps = {
  generate: generateStructured,
  newTurnId: () => crypto.randomUUID(),
};

/**
 * One look while Watch is on (the island's eye button): is there a slip in the student's working
 * on screen? Almost every look is "fine" or "nothing", and the desktop app says nothing then. A
 * mistake comes back with its speech and ink, after the same safety check as every screen
 * answer; a reply that fails it is dropped (Watch stays quiet rather than say something unsafe).
 *
 * The screenshot is forwarded to the model (`store: false`) and dropped with the request.
 */
export async function watchScreen(
  request: ScreenWatchRequest,
  language: NebLanguage | undefined,
  signal?: AbortSignal,
  deps: ScreenWatchDeps = screenWatchDeps,
): Promise<ScreenWatchReply> {
  let made: ScreenWatchModelResponse;
  try {
    made = await deps.generate({
      model: screenModel(),
      purpose: "screen-watch",
      system: inLanguage(SCREEN_WATCH_PROMPT.system, language),
      input: [
        { type: "text" as const, text: renderWatchInput(request) },
        { type: "image" as const, base64: request.image.jpeg, mimeType: "image/jpeg" as const },
      ],
      schema: ScreenWatchModelResponse,
      thinkingLevel: "low" as const,
      maxOutputTokens: 1024,
      timeoutMs: SCREEN_WATCH_TIMEOUT_MS,
      ...(signal && { signal }),
    });
  } catch (error) {
    throw new HttpError(503, unavailableMessage(error));
  }
  const speech = made.speech.trim();
  if (made.status !== "mistake" || !speech) {
    return { status: made.status === "nothing" ? "nothing" : "fine" };
  }
  const checked = checkScreenReply(
    withFocusRegion({
      speech: clipSpeech(speech, SCREEN_LIMITS.speechChars),
      actions: made.actions,
      mode: "answer",
    }),
  );
  if (checked.blocked.length > 0) {
    // Counts only: never what was said.
    console.info(`[screen-watch] safety check dropped a reply (${checked.blocked.join(", ")})`);
    return { status: "fine" };
  }
  return {
    status: "mistake",
    speech: checked.response.speech,
    actions: checked.response.actions,
    turnId: deps.newTurnId(),
  };
}
