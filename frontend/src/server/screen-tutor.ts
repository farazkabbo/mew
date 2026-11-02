import "server-only";

import {
  checkScreenReply,
  type CourseExcerpt,
  type NebLanguage,
  renderScreenInput,
  SAFE_FALLBACK,
  SCREEN_LIMITS,
  inLanguage,
  SCREEN_TUTOR_PROMPT,
  type ScreenAskRequest,
  type ScreenStreamEvent,
  ScreenTutorResponse,
  unsafeReasons,
  type WalkthroughContext,
  withFocusRegion,
} from "@mew/shared";

import { screenModel } from "./env";
import {
  type GenerateStructured,
  generateStructured,
  ModelBusyError,
  parseJson,
  type StreamStructuredText,
  streamStructuredText,
} from "./gemini";
import { completedStringField } from "./partial-json";
import { clipSpeech, unavailableMessage } from "./tutor";

const SCREEN_TUTOR_TIMEOUT_MS = 15_000;

type ScreenTutorDeps = {
  stream: StreamStructuredText;
  generate: GenerateStructured;
  now: () => number;
  newTurnId: () => string;
};

/**
 * A question about the screen, the walkthrough it was asked in (coach mode, S4), if any, and the
 * student's course passages about it (S5), if any.
 */
export type ScreenQuestion = ScreenAskRequest & {
  walkthrough?: WalkthroughContext;
  courseContext?: readonly CourseExcerpt[];
};

const defaultDeps: ScreenTutorDeps = {
  stream: streamStructuredText,
  generate: generateStructured,
  now: () => performance.now(),
  newTurnId: () => crypto.randomUUID(),
};

/**
 * Answers one question about the student's screen, streaming events: `speech` as soon as the
 * spoken reply is complete (so the desktop app can start speaking), then the validated
 * `response`.
 *
 * Every reply passes the rule-based safety check (decision 3) before it's sent: the speech on
 * its own as soon as it's known, then the whole reply. A blocked reply becomes SAFE_FALLBACK.
 * The screenshot is only forwarded to the model (`store: false`), never kept.
 */
export async function* runScreenTutor(
  request: ScreenQuestion & { language?: NebLanguage },
  signal?: AbortSignal,
  deps: ScreenTutorDeps = defaultDeps,
): AsyncGenerator<ScreenStreamEvent> {
  const started = deps.now();
  const elapsed = () => Math.round(deps.now() - started);
  const generation = {
    model: screenModel(),
    system: inLanguage(SCREEN_TUTOR_PROMPT.system, request.language),
    input: [
      {
        type: "text" as const,
        text: renderScreenInput(request, request.walkthrough, request.courseContext),
      },
      { type: "image" as const, base64: request.image.jpeg, mimeType: "image/jpeg" as const },
    ],
    schema: ScreenTutorResponse,
    thinkingLevel: "low" as const,
    maxOutputTokens: 1024,
    timeoutMs: SCREEN_TUTOR_TIMEOUT_MS,
    ...(signal && { signal }),
  };

  let spoken: string | null = null;
  let speechBlocked = false;
  try {
    let text = "";
    for await (const chunk of deps.stream(generation)) {
      text += chunk;
      if (spoken !== null) continue;
      const speech = completedStringField(text, "speech")?.trim();
      if (!speech) continue;
      speechBlocked = unsafeReasons(speech).length > 0;
      spoken = speechBlocked ? SAFE_FALLBACK.speech : clipSpeech(speech, SCREEN_LIMITS.speechChars);
      yield { type: "speech", text: spoken, latencyMs: elapsed() };
    }

    const generated =
      ScreenTutorResponse.safeParse(parseJson(text)).data ?? (await deps.generate(generation));
    // One focus region, first (it anchors the ink and is the default clip, S3 §2.1).
    const checked = checkScreenReply(withFocusRegion(generated));
    if (checked.blocked.length > 0 || speechBlocked) {
      // Counts only: never what was said.
      console.info(
        `[screen] safety check replaced a reply (${checked.blocked.join(", ") || "speech"})`,
      );
    }
    const response = speechBlocked ? SAFE_FALLBACK : checked.response;
    if (spoken === null) {
      spoken = response.speech;
      yield { type: "speech", text: spoken, latencyMs: elapsed() };
    }
    // What was already said aloud stays the reply, even if a retry phrased it differently.
    yield {
      type: "response",
      response: { ...response, speech: spoken },
      turnId: deps.newTurnId(),
      latencyMs: elapsed(),
    };
  } catch (error) {
    if (signal?.aborted) return;
    if (!(error instanceof ModelBusyError)) {
      console.warn("[screen] generation failed:", error instanceof Error ? error.name : "error");
    }
    yield spoken === null
      ? { type: "error", message: unavailableMessage(error) }
      : {
          type: "response",
          response: { speech: spoken, actions: [], mode: "answer" },
          turnId: deps.newTurnId(),
          latencyMs: elapsed(),
        };
  }
}
