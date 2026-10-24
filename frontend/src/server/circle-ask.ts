import "server-only";

import {
  checkedStep,
  CIRCLE_ASK_PROMPT,
  CIRCLE_LIMITS,
  type CircleAskRequest,
  CircleAskModelResponse,
  circleAnswerReasons,
  CircleModelStep,
  circleStepReasons,
  type CircleStep,
  type CircleStreamEvent,
  marksBox,
  READ_QUESTION_PROMPT,
  type ReadQuestionRequest,
  ReadQuestionResponse,
  renderCircleInput,
  SAFE_FALLBACK,
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
import { completedArrayItems } from "./partial-json";
import { unavailableMessage } from "./tutor";

/**
 * Circle & Ask on the server (S3.2, brief §3.4–3.6): one model call explains what the student
 * marked, in steps that stream to the desktop app as each one is written, so the first step's
 * ink can start while the rest is still being written.
 *
 * Every step is checked in code before it's sent (`checkedStep`: ink near the marks, short notes,
 * at most 25 words) and passes the rule-based safety check (decision 3). A step that fails it
 * aborts the whole answer: the desktop app takes back what it drew and says the safe fallback.
 * Screenshots are only forwarded to the model (`store: false`), never kept.
 */

const ANSWER_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 10_000;

/** Said when no step could be made at all (brief §3.6: one caption, no ink). */
export const CIRCLE_FALLBACK = "I couldn't work that out just now. Try asking again in a moment.";

export type CircleAskDeps = {
  stream: StreamStructuredText;
  generate: GenerateStructured;
  now: () => number;
  newTurnId: () => string;
};

const defaultDeps: CircleAskDeps = {
  stream: streamStructuredText,
  generate: generateStructured,
  now: () => performance.now(),
  newTurnId: () => crypto.randomUUID(),
};

export async function* runCircleAsk(
  request: CircleAskRequest,
  signal?: AbortSignal,
  deps: CircleAskDeps = defaultDeps,
): AsyncGenerator<CircleStreamEvent> {
  const started = deps.now();
  const elapsed = () => Math.round(deps.now() - started);
  const limits = {
    marks: marksBox(request.marks),
    widthPx: request.focus.widthPx,
    heightPx: request.focus.heightPx,
  };
  const generation = {
    model: screenModel(),
    system: CIRCLE_ASK_PROMPT.system,
    input: [
      { type: "text" as const, text: renderCircleInput(request) },
      { type: "image" as const, base64: request.focus.image.jpeg, mimeType: "image/jpeg" as const },
      { type: "image" as const, base64: request.context.jpeg, mimeType: "image/jpeg" as const },
    ],
    schema: CircleAskModelResponse,
    thinkingLevel: "low" as const,
    maxOutputTokens: 2048,
    timeoutMs: ANSWER_TIMEOUT_MS,
    ...(signal && { signal }),
  };

  let sent = 0;
  /** Checks and sends the model's steps from `sent` on; false if one was unsafe (aborted). */
  const send = function* (steps: readonly unknown[]): Generator<CircleStreamEvent, boolean> {
    while (sent < steps.length && sent < CIRCLE_LIMITS.maxSteps) {
      const parsed = CircleModelStep.safeParse(steps[sent]);
      if (!parsed.success) return true; // wait for the full answer (or the retry)
      const step = checkedStep(parsed.data, sent, limits);
      const blocked = circleStepReasons(step);
      if (blocked.length > 0) {
        // Counts only: never what was said.
        console.info(`[circle] safety check stopped an answer (${blocked.join(", ")})`);
        yield { type: "abort", speech: SAFE_FALLBACK.speech };
        return false;
      }
      sent++;
      yield { type: "step", step, latencyMs: elapsed() };
    }
    return true;
  };

  try {
    let text = "";
    for await (const chunk of deps.stream(generation)) {
      text += chunk;
      if (!(yield* send(completedArrayItems(text, "steps")))) return;
    }
    let answer = CircleAskModelResponse.safeParse(parseJson(text)).data;
    // Retry once without streaming when nothing usable came (brief §3.6).
    if (!answer && sent === 0) answer = await deps.generate(generation);
    if (answer && !(yield* send(answer.steps))) return;
    if (sent === 0) {
      yield fallbackStep(elapsed());
    }
    yield done(answer, deps.newTurnId(), elapsed());
  } catch (error) {
    if (signal?.aborted) return;
    if (!(error instanceof ModelBusyError)) {
      console.warn("[circle] answer failed:", error instanceof Error ? error.name : "error");
    }
    if (sent === 0 && error instanceof ModelBusyError) {
      yield { type: "error", message: unavailableMessage(error) };
      return;
    }
    if (sent === 0) yield fallbackStep(elapsed());
    yield done(null, deps.newTurnId(), elapsed());
  }
}

function fallbackStep(latencyMs: number): CircleStreamEvent {
  const step: CircleStep = { index: 0, say: CIRCLE_FALLBACK, actions: [] };
  return { type: "step", step, latencyMs };
}

/** The end of an answer: what's kept in the notebook, minus anything the safety check stops. */
function done(
  answer: CircleAskModelResponse | null | undefined,
  turnId: string,
  latencyMs: number,
): CircleStreamEvent {
  const kept = {
    summary: answer?.summary ?? CIRCLE_FALLBACK,
    followUpQuestion: answer?.followUpQuestion ?? null,
    conceptHints: (answer?.conceptHints ?? []).slice(0, CIRCLE_LIMITS.conceptHints),
  };
  const blocked = circleAnswerReasons(kept).length > 0;
  return {
    type: "done",
    turnId,
    readQuestion: answer?.readQuestion ?? "Explain this",
    // Unsafe words never reach the notebook: the summary goes, and so do the extras.
    summary: blocked ? "Explained on screen." : kept.summary,
    followUpQuestion: blocked ? null : kept.followUpQuestion,
    conceptHints: blocked ? [] : kept.conceptHints,
    latencyMs,
  };
}

/**
 * Reads a question the student selected on screen that the device couldn't read itself
 * (handwriting, brief §3.5). The crop is only forwarded to the model, never kept.
 */
export async function readQuestion(
  request: ReadQuestionRequest,
  signal?: AbortSignal,
  generate: GenerateStructured = generateStructured,
): Promise<ReadQuestionResponse> {
  return generate({
    model: screenModel(),
    system: READ_QUESTION_PROMPT.system,
    input: [
      { type: "text", text: "Read the question(s) in this image." },
      { type: "image", base64: request.image.jpeg, mimeType: "image/jpeg" },
    ],
    schema: ReadQuestionResponse,
    thinkingLevel: "low",
    maxOutputTokens: 512,
    timeoutMs: READ_TIMEOUT_MS,
    ...(signal && { signal }),
  });
}
