import "server-only";

import {
  renderTutorInput,
  TUTOR_LIMITS,
  TUTOR_PROMPT,
  type TutorRequest,
  TutorResponse,
  type TutorStreamEvent,
} from "@mew/shared";

import { geminiEnv } from "./env";
import {
  type GenerateStructured,
  generateStructured,
  type InputPart,
  ModelBusyError,
  parseJson,
  type StreamStructuredText,
  streamStructuredText,
} from "./gemini";
import { completedStringField } from "./partial-json";

const TUTOR_TIMEOUT_MS = 20_000;

type TutorDeps = {
  stream: StreamStructuredText;
  generate: GenerateStructured;
  now: () => number;
};

const defaultDeps: TutorDeps = {
  stream: streamStructuredText,
  generate: generateStructured,
  now: () => performance.now(),
};

/**
 * Runs one tutor turn, streaming events: `speech` as soon as the spoken reply is complete (so
 * audio can start while board actions are still generating), then the validated `response`.
 *
 * Failure handling (brief §14): invalid output is retried once; if that fails too, the turn
 * degrades to speech only — or to an `error` event when nothing could be said.
 */
export async function* runTutor(
  request: TutorRequest,
  signal?: AbortSignal,
  deps: TutorDeps = defaultDeps,
): AsyncGenerator<TutorStreamEvent> {
  const started = deps.now();
  const elapsed = () => Math.round(deps.now() - started);
  const generation = {
    model: geminiEnv().GEMINI_TUTOR_MODEL,
    system: TUTOR_PROMPT.system,
    input: tutorInput(request),
    schema: TutorResponse,
    thinkingLevel: request.depth === "deep" ? ("high" as const) : ("low" as const),
    maxOutputTokens: request.depth === "deep" ? 4096 : 1536,
    timeoutMs: TUTOR_TIMEOUT_MS,
    ...(signal && { signal }),
  };

  let spoken: string | null = null;
  try {
    let text = "";
    for await (const chunk of deps.stream(generation)) {
      text += chunk;
      if (spoken === null) {
        const speech = completedStringField(text, "speech")?.trim();
        if (speech) {
          spoken = clipSpeech(speech);
          yield { type: "speech", text: spoken, latencyMs: elapsed() };
        }
      }
    }

    let response = TutorResponse.safeParse(parseJson(text)).data;
    response ??= await deps.generate(generation);
    if (spoken === null) {
      spoken = response.speech;
      yield { type: "speech", text: spoken, latencyMs: elapsed() };
    }
    // What was already said aloud stays the reply, even if a retry phrased it differently.
    yield { type: "response", response: { ...response, speech: spoken }, latencyMs: elapsed() };
  } catch (error) {
    if (signal?.aborted) return;
    if (!(error instanceof ModelBusyError)) {
      console.warn("[tutor] generation failed:", error instanceof Error ? error.message : error);
    }
    yield spoken === null
      ? { type: "error", message: unavailableMessage(error) }
      : { type: "response", response: { speech: spoken, actions: [] }, latencyMs: elapsed() };
  }
}

/** What the student is told when no reply could be made. */
export function unavailableMessage(error: unknown): string {
  if (!(error instanceof ModelBusyError))
    return "I couldn't answer just now — try again in a moment.";
  const seconds = Math.ceil(error.retryAfterMs / 1000);
  const when = seconds < 90 ? "in a minute" : `in about ${Math.ceil(seconds / 60)} minutes`;
  return `The tutor is busy right now (too many requests to the model). Try again ${when}.`;
}

function tutorInput(request: TutorRequest): InputPart[] {
  const parts: InputPart[] = [{ type: "text", text: renderTutorInput(request) }];
  if (request.pageImage)
    parts.push({ type: "image", base64: request.pageImage, mimeType: "image/png" });
  return parts;
}

/** Keeps speech within limits, cutting at a sentence end where possible. */
export function clipSpeech(speech: string, maxChars: number = TUTOR_LIMITS.speechChars): string {
  if (speech.length <= maxChars) return speech;
  const cut = speech.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > 40 ? cut.slice(0, end + 1) : cut;
}
