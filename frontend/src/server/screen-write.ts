import "server-only";

import {
  inLanguage,
  type NebLanguage,
  renderWriteInput,
  SCREEN_LIMITS,
  SCREEN_WRITE_LIMITS,
  SCREEN_WRITE_PROMPT,
  type ScreenWriteEvent,
  ScreenWriteKind,
  ScreenWriteModelResponse,
  type ScreenWriteRequest,
  unsafeReasons,
} from "@mew/shared";

import { screenModel } from "./env";
import { type StreamStructuredText, streamStructuredText } from "./gemini";
import { completedStringField, partialStringField } from "./partial-json";
import { clipSpeech, unavailableMessage } from "./tutor";

/** Long enough for an essay of about 1,500 words to be written. */
const SCREEN_WRITE_TIMEOUT_MS = 60_000;
/** How much already-sent text is checked again with each new piece (a phrase can straddle two). */
const SAFETY_OVERLAP_CHARS = 200;

export const SCREEN_WRITE_MESSAGES = {
  unsafe: "I can't type that one. Try asking another way.",
  nothing: "I couldn't write that just now. Try again in a moment.",
} as const;

export type ScreenWriteDeps = {
  stream: StreamStructuredText;
  newTurnId: () => string;
};

export const screenWriteDeps: ScreenWriteDeps = {
  stream: streamStructuredText,
  newTurnId: () => crypto.randomUUID(),
};

/**
 * "Write an essay on cats", "rewrite this sentence" (Screen Coach, typing into a document): the
 * text for the desktop app to type into the app in front, streamed as the model writes it so the
 * typing starts within a second or two, after a sentence to say first.
 *
 * Text is sent on a word at a time, and each new piece passes the same rule-based safety check
 * as every screen answer (with the end of what was already sent, so a phrase can't slip through
 * across two pieces). If the speech fails it, nothing is typed; if a piece fails it, the typing
 * stops there.
 *
 * The screenshot is forwarded to the model (`store: false`) and dropped with the request.
 */
export async function* writeForScreen(
  request: ScreenWriteRequest,
  language: NebLanguage | undefined,
  signal?: AbortSignal,
  deps: ScreenWriteDeps = screenWriteDeps,
): AsyncGenerator<ScreenWriteEvent> {
  let raw = "";
  let started = false;
  let stopped = false;
  /** How much of the text has been sent on. */
  let sent = 0;

  function* step(final: boolean): Generator<ScreenWriteEvent> {
    if (!started) {
      const speech = completedStringField(raw, "speech")?.trim();
      const kind = ScreenWriteKind.safeParse(completedStringField(raw, "kind"));
      if (!speech || !kind.success) return;
      started = true;
      const turnId = deps.newTurnId();
      if (unsafeReasons(speech).length > 0) {
        console.info("[screen-write] safety check dropped a reply (speech)");
        stopped = true;
        yield { type: "start", speech: SCREEN_WRITE_MESSAGES.unsafe, kind: "insert", turnId };
        yield { type: "done" };
        return;
      }
      yield {
        type: "start",
        speech: clipSpeech(speech, SCREEN_LIMITS.speechChars),
        kind: kind.data,
        turnId,
      };
    }
    const field = partialStringField(raw, "text");
    if (!field) return;
    const text = typeable(field.value).slice(0, SCREEN_WRITE_LIMITS.textChars);
    // Whole words only, until the text is finished.
    const end = final || field.done ? text.length : text.search(/\s\S*$/) + 1;
    if (end <= sent) return;
    const reasons = unsafeReasons(text.slice(Math.max(0, sent - SAFETY_OVERLAP_CHARS), end));
    if (reasons.length > 0) {
      // Counts only: never what was written.
      console.info(`[screen-write] safety check stopped a reply (${reasons.join(", ")})`);
      stopped = true;
      yield { type: "error", message: SCREEN_WRITE_MESSAGES.unsafe };
      return;
    }
    for (let at = sent; at < end; at += SCREEN_WRITE_LIMITS.pieceChars) {
      yield {
        type: "text",
        text: text.slice(at, Math.min(end, at + SCREEN_WRITE_LIMITS.pieceChars)),
      };
    }
    sent = end;
  }

  try {
    const chunks = deps.stream({
      model: screenModel(),
      purpose: "screen-write",
      system: inLanguage(SCREEN_WRITE_PROMPT.system, language),
      input: [
        { type: "text" as const, text: renderWriteInput(request) },
        { type: "image" as const, base64: request.image.jpeg, mimeType: "image/jpeg" as const },
      ],
      schema: ScreenWriteModelResponse,
      // Writing needs no reasoning, and the student is waiting with the document open.
      thinkingLevel: "minimal" as const,
      maxOutputTokens: 6144,
      timeoutMs: SCREEN_WRITE_TIMEOUT_MS,
      ...(signal && { signal }),
    });
    for await (const chunk of chunks) {
      raw += chunk;
      yield* step(false);
      if (stopped) return;
    }
    yield* step(true);
    if (stopped) return;
    yield started ? { type: "done" } : { type: "error", message: SCREEN_WRITE_MESSAGES.nothing };
  } catch (error) {
    if (signal?.aborted) return;
    console.warn("[screen-write] failed:", error instanceof Error ? error.message : error);
    yield {
      type: "error",
      message: clipSpeech(unavailableMessage(error), SCREEN_LIMITS.speechChars),
    };
  }
}

/**
 * Only what can be typed: Windows line endings become one new line each, and any other control
 * character is dropped (the desktop app refuses a piece that has one).
 */
function typeable(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[^\t\n\P{Cc}]/gu, "");
}
