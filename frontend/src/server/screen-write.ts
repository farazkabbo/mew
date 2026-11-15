import "server-only";

import {
  inLanguage,
  type NebLanguage,
  renderWriteInput,
  SCREEN_LIMITS,
  SCREEN_WRITE_PROMPT,
  ScreenWriteModelResponse,
  type ScreenWriteReply,
  type ScreenWriteRequest,
  unsafeReasons,
} from "@mew/shared";

import { screenModel } from "./env";
import { type GenerateStructured, generateStructured } from "./gemini";
import { HttpError } from "./http-error";
import { clipSpeech, unavailableMessage } from "./tutor";

const SCREEN_WRITE_TIMEOUT_MS = 20_000;

export const SCREEN_WRITE_MESSAGES = {
  unsafe: "I can't type that one. Try asking another way.",
} as const;

export type ScreenWriteDeps = {
  generate: GenerateStructured;
  newTurnId: () => string;
};

export const screenWriteDeps: ScreenWriteDeps = {
  generate: generateStructured,
  newTurnId: () => crypto.randomUUID(),
};

/**
 * "Type a conclusion", "rewrite this sentence" (Screen Coach, typing into a document): the text
 * for the desktop app to type into the app in front, and a sentence to say first. The text and
 * the speech pass the same rule-based safety check as every screen answer; if either fails,
 * nothing is typed.
 *
 * The screenshot is forwarded to the model (`store: false`) and dropped with the request.
 */
export async function writeForScreen(
  request: ScreenWriteRequest,
  language: NebLanguage | undefined,
  signal?: AbortSignal,
  deps: ScreenWriteDeps = screenWriteDeps,
): Promise<ScreenWriteReply> {
  let made: ScreenWriteModelResponse;
  try {
    made = await deps.generate({
      model: screenModel(),
      purpose: "screen-write",
      system: inLanguage(SCREEN_WRITE_PROMPT.system, language),
      input: [
        { type: "text" as const, text: renderWriteInput(request) },
        { type: "image" as const, base64: request.image.jpeg, mimeType: "image/jpeg" as const },
      ],
      schema: ScreenWriteModelResponse,
      thinkingLevel: "low" as const,
      maxOutputTokens: 2048,
      timeoutMs: SCREEN_WRITE_TIMEOUT_MS,
      ...(signal && { signal }),
    });
  } catch (error) {
    throw new HttpError(503, unavailableMessage(error));
  }
  const blocked = [...new Set([made.speech, made.text].flatMap(unsafeReasons))];
  if (blocked.length > 0) {
    // Counts only: never what was written.
    console.info(`[screen-write] safety check dropped a reply (${blocked.join(", ")})`);
    return {
      speech: SCREEN_WRITE_MESSAGES.unsafe,
      kind: "insert",
      text: "",
      turnId: deps.newTurnId(),
    };
  }
  return {
    speech: clipSpeech(made.speech.trim(), SCREEN_LIMITS.speechChars),
    kind: made.kind,
    // Windows line endings are typed as one new line each.
    text: made.text.replace(/\r\n?/g, "\n"),
    turnId: deps.newTurnId(),
  };
}
