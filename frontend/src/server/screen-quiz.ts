import "server-only";

import {
  type CheckQuestion,
  renderScreenQuizInput,
  SCREEN_QUIZ_LIMITS,
  SCREEN_QUIZ_PROMPT,
  type ScreenQuizAnswerReply,
  type ScreenQuizAnswerRequest,
  ScreenQuizModelResponse,
  type ScreenQuizReply,
  type ScreenQuizRequest,
  unsafeReasons,
} from "@mew/shared";
import { z } from "zod";

import { ApiError, apiFetch } from "./api-client";
import { verifiedCheckQuestion } from "./check-question";
import { screenModel } from "./env";
import { type GenerateStructured, generateStructured } from "./gemini";
import { HttpError } from "./http-error";
import { CheckWithKey, gradeCheck } from "./moment-checks";
import { gradeAnswer } from "./quiz";
import { type CheckMath, checkMathRemote } from "./solution";
import { clipSpeech, unavailableMessage } from "./tutor";

/**
 * "Quiz me on this" (Screen Coach S6, docs/SCREEN_COACH.md §2.5): 1–3 practice questions about
 * what's on the student's screen, asked there and then, each kept as a recall card in the review
 * queue (a K8 moment check with origin `screen_quiz`).
 *
 * Every key is verified before it's kept (maths by SymPy, chemistry by balance, a multiple choice
 * by its key being a choice) and every text passes the rule-based safety check; a question that
 * fails either is dropped. The keys stay on the API and this server: the desktop app only ever
 * gets the questions, and an answer given on screen is graded here.
 *
 * The screenshot is forwarded to the model (`store: false`) and dropped with the request.
 */

const SCREEN_QUIZ_TIMEOUT_MS = 20_000;
const SL = SCREEN_QUIZ_LIMITS;

export const SCREEN_QUIZ_MESSAGES = {
  nothing: "There's nothing here I can quiz you on. Open what you're studying and ask again.",
  unsure: "I couldn't make questions I'm sure of from this screen. Try a page with more on it.",
  right: "That's it.",
} as const;

/** A quiz card kept by the API (the device's owner's), with its key. */
type QuizStore = {
  keep(
    cards: { question: CheckQuestion; hints: string[] }[],
    source: { title: string | null; app: string | null },
  ): Promise<string[]>;
  check(id: string): Promise<CheckWithKey | null>;
};

export type ScreenQuizDeps = {
  generate: GenerateStructured;
  checkMath: CheckMath;
  grade: typeof gradeAnswer;
  store: QuizStore;
};

export function deviceQuizStore(token: string): QuizStore {
  const headers = { "X-Mew-Device-Token": token };
  return {
    keep: async (cards, source) => {
      const { checkIds } = await apiFetch(
        "/v1/moments/device/quiz",
        z.object({ checkIds: z.array(z.uuid()) }),
        {
          method: "POST",
          body: { questions: cards, sourceTitle: source.title, sourceApp: source.app },
          headers,
          timeoutMs: 8_000,
        },
      );
      return checkIds;
    },
    check: async (id) => {
      try {
        return await apiFetch(`/v1/moments/device/checks/${id}`, CheckWithKey, {
          headers,
          timeoutMs: 8_000,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  };
}

export function screenQuizDeps(token: string): ScreenQuizDeps {
  return {
    generate: generateStructured,
    checkMath: checkMathRemote,
    grade: gradeAnswer,
    store: deviceQuizStore(token),
  };
}

/** Makes the questions, keeps the ones that pass, and says the first sentence. */
export async function makeScreenQuiz(
  request: ScreenQuizRequest,
  deps: ScreenQuizDeps,
  signal?: AbortSignal,
): Promise<ScreenQuizReply> {
  let made: ScreenQuizModelResponse;
  try {
    made = await deps.generate({
      model: screenModel(),
      system: SCREEN_QUIZ_PROMPT.system,
      input: [
        { type: "text" as const, text: renderScreenQuizInput(request) },
        { type: "image" as const, base64: request.image.jpeg, mimeType: "image/jpeg" as const },
      ],
      schema: ScreenQuizModelResponse,
      thinkingLevel: "low" as const,
      maxOutputTokens: 2048,
      timeoutMs: SCREEN_QUIZ_TIMEOUT_MS,
      ...(signal && { signal }),
    });
  } catch (error) {
    throw new HttpError(503, unavailableMessage(error));
  }

  if (made.questions.length === 0) {
    return { speech: safeSpeech(made.intro, SCREEN_QUIZ_MESSAGES.nothing), questions: [] };
  }
  const verified = await Promise.all(
    made.questions.map((q) => verifiedCheckQuestion(q, deps.checkMath)),
  );
  const kept = verified.filter((q): q is CheckQuestion => q !== null).slice(0, SL.questions);
  if (kept.length < made.questions.length) {
    // Counts only: never the questions.
    console.info(`[screen-quiz] dropped ${made.questions.length - kept.length} question(s)`);
  }
  if (kept.length === 0) return { speech: SCREEN_QUIZ_MESSAGES.unsure, questions: [] };

  const hints = made.conceptHints.slice(0, 5);
  const ids = await deps.store.keep(
    kept.map((question) => ({ question, hints })),
    { title: request.title ?? null, app: request.app },
  );
  return {
    speech: safeSpeech(made.intro, countLine(ids.length)),
    questions: kept.slice(0, ids.length).map((q, i) => ({
      checkId: ids[i] as string,
      prompt: q.prompt,
      kind: q.kind,
      choices: q.kind === "mcq" ? q.choices : [],
    })),
  };
}

/**
 * An answer given on screen: right or not, and what to say (with the key, after). It doesn't
 * reschedule the card: the review asks it again later, cold, which is the point of the card.
 */
export async function answerScreenQuiz(
  request: ScreenQuizAnswerRequest,
  deps: ScreenQuizDeps,
): Promise<ScreenQuizAnswerReply> {
  const check = await deps.store.check(request.checkId);
  if (!check) throw new HttpError(404, "Not found");
  const graded = await gradeCheck(check, request.answer, deps);
  const speech = graded.correct
    ? SCREEN_QUIZ_MESSAGES.right
    : `Not quite. The answer: ${check.answerKey}`;
  return {
    correct: graded.correct,
    speech: safeSpeech(speech, graded.correct ? SCREEN_QUIZ_MESSAGES.right : "Not quite."),
  };
}

function countLine(count: number): string {
  return count === 1
    ? "One question on this."
    : `${count === 2 ? "Two" : "Three"} questions on this.`;
}

/** Said aloud: checked by the rule-based safety check, else the fallback. */
function safeSpeech(text: string, fallback: string): string {
  const clipped = clipSpeech(text.trim(), SL.speechChars);
  return clipped && unsafeReasons(clipped).length === 0 ? clipped : fallback;
}
