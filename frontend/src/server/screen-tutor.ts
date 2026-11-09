import "server-only";

import {
  checkScreenReply,
  type CourseExcerpt,
  type NebLanguage,
  needsScreen,
  renderScreenInput,
  SAFE_FALLBACK,
  SCREEN_LIMITS,
  inLanguage,
  SCREEN_TUTOR_PROMPT,
  type ScreenAskRequest,
  type ScreenStreamEvent,
  ScreenTutorModelResponse,
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
import { reusingAnswers } from "./answer-cache";
import { completedStringField } from "./partial-json";
import { excerpts, notebookEvent, type StudentNote } from "./student-notes";
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
  stream: reusingAnswers(streamStructuredText),
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
  request: ScreenQuestion & { language?: NebLanguage; studentNotes?: readonly StudentNote[] },
  signal?: AbortSignal,
  deps: ScreenTutorDeps = defaultDeps,
): AsyncGenerator<ScreenStreamEvent> {
  const started = deps.now();
  const elapsed = () => Math.round(deps.now() - started);
  // A question that doesn't need the screen goes without it (a walkthrough always looks).
  const withScreen =
    request.walkthrough !== undefined || needsScreen(request.transcript, request.language);
  const generation = {
    model: screenModel(),
    purpose: "screen-ask",
    system: inLanguage(SCREEN_TUTOR_PROMPT.system, request.language),
    input: [
      {
        type: "text" as const,
        text: renderScreenInput(
          request,
          request.walkthrough,
          request.courseContext,
          withScreen,
          excerpts(request.studentNotes ?? []),
        ),
      },
      ...(withScreen
        ? [{ type: "image" as const, base64: request.image.jpeg, mimeType: "image/jpeg" as const }]
        : []),
    ],
    schema: ScreenTutorModelResponse,
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

    // Which of the student's own lines it taught from goes in its own event, not the reply.
    const { fromNotes, ...generated } =
      ScreenTutorModelResponse.safeParse(parseJson(text)).data ?? (await deps.generate(generation));
    // One focus region, first (it anchors the ink and is the default clip, S3 §2.1).
    // Without the screen there's nowhere to draw: anything it drew anyway would be a guess.
    const checked = checkScreenReply(
      withFocusRegion(withScreen ? generated : { ...generated, actions: [] }),
    );
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
    // Taught from the student's own notes: where, so the desktop can open them there.
    const notes = speechBlocked
      ? null
      : notebookEvent(request.studentNotes ?? [], fromNotes, request.transcript);
    if (notes) yield notes;
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
