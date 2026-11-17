import "server-only";

import {
  inLanguage,
  isOpenableUrl,
  isRiskyLabel,
  type NebLanguage,
  renderActInput,
  SCREEN_ACT_FIRST_KEYS,
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

const SCREEN_ACT_TIMEOUT_MS = 25_000;

export const SCREEN_ACT_MESSAGES = {
  unsafe: "I'll leave that one to you.",
  risky: (label: string) => `That one's yours to press: ${label}.`,
  here: (label: string) => `Here it is: ${label}.`,
  shown: "I've shown you where it is. The writing's yours from here.",
  address: "I can't open that address. Open it yourself and ask me again.",
  needsUpdate: "That needs the newest Neb. Update the app and ask me again.",
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
 * Whatever the model chose, a click on a control whose name says it buys, sends, deletes, signs
 * in or the like is never passed on: Neb's cursor points at it instead and the student presses
 * it (in "show" mode that's the answer: "here it is"). Anything said or typed that fails the
 * rule-based safety check every screen answer passes becomes a stop.
 *
 * The model's `plan` and `note` (its memory between looks) pass the same check and go back to
 * the desktop app, which sends them with the next look; nothing is kept here.
 *
 * The first hand (desktop 0.1.5) sends no `mode` and knows neither `point` nor `wait` nor the
 * newer keys: it's answered with a stop in their place.
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
      maxOutputTokens: 1024,
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
    ...(made.plan ? [made.plan] : []),
    ...(made.note ? [made.note] : []),
    ...(action.type === "type" ? [action.text] : []),
    ...(action.type === "write" ? [action.request] : []),
    ...(action.type === "open" ? [action.target] : []),
  ];
  const blocked = [...new Set(said.flatMap(unsafeReasons))];
  if (blocked.length > 0) {
    // Counts only: never what was said or typed.
    console.info(`[screen-act] safety check dropped an action (${blocked.join(", ")})`);
    return { speech: SCREEN_ACT_MESSAGES.unsafe, action: { type: "stop" }, turnId };
  }
  const first = request.mode === undefined;
  const show = request.mode === "show";
  const say = (speech: string) => clipSpeech(speech.trim(), SCREEN_LIMITS.speechChars);
  // Neb's own memory for the next look: kept by the desktop app, in memory, until it stops.
  const plan = made.plan?.trim();
  const note = made.note?.trim();
  const memory = first ? {} : { ...(plan && { plan }), ...(note && { note }) };
  if (action.type === "click" && isRiskyLabel(action.label)) {
    const speech = say(
      show ? SCREEN_ACT_MESSAGES.here(action.label) : SCREEN_ACT_MESSAGES.risky(action.label),
    );
    return first
      ? { speech, action: { type: "stop" }, turnId }
      : {
          ...memory,
          speech,
          action: { type: "point", point: action.point, label: action.label },
          turnId,
        };
  }
  if (action.type === "open" && action.what === "site" && !isOpenableUrl(action.target)) {
    return { speech: SCREEN_ACT_MESSAGES.address, action: { type: "stop" }, turnId };
  }
  if (show && action.type === "write") {
    return { speech: SCREEN_ACT_MESSAGES.shown, action: { type: "stop" }, turnId };
  }
  if (first) {
    if (action.type === "point") {
      return { speech: say(made.speech), action: { type: "stop" }, turnId };
    }
    const newKey =
      action.type === "key" && !(SCREEN_ACT_FIRST_KEYS as readonly string[]).includes(action.key);
    if (action.type === "wait" || action.type === "open" || newKey) {
      return { speech: SCREEN_ACT_MESSAGES.needsUpdate, action: { type: "stop" }, turnId };
    }
  }
  return { ...memory, speech: say(made.speech), action, turnId };
}
