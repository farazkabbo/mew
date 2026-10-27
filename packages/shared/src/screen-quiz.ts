import { z } from "zod";

import { CheckQuestion } from "./moments";
import { AppName, ScreenImage } from "./screen";
import { Subject } from "./tutor";

/**
 * Quiz me on this (Screen Coach S6, docs/SCREEN_COACH.md §2.5): "quiz me on this" turns what's
 * on the screen into 1–3 practice questions, asked there and then (by voice or typed in the quiz
 * card), and each becomes a recall card in the review queue: K8's moment checks, so they're
 * scheduled, capped and answered like a saved moment's.
 *
 * The keys stay on the server; the desktop app only ever has the questions.
 */
export const SCREEN_QUIZ_LIMITS = {
  questions: 3,
  titleChars: 200,
  speechChars: 300,
  answerChars: 500,
} as const;

const L = SCREEN_QUIZ_LIMITS;

/** `POST /api/screen/quiz` (device token): the screen to make questions from. */
export const ScreenQuizRequest = z.object({
  app: AppName.nullable(),
  /** The window's title, kept with the cards so the review can say where they came from. */
  title: z.string().trim().min(1).max(L.titleChars).optional(),
  scope: z.enum(["window", "monitor"]),
  image: ScreenImage,
});
export type ScreenQuizRequest = z.infer<typeof ScreenQuizRequest>;

/** What the model returns (prompt `screen-quiz`). */
export const ScreenQuizModelResponse = z.object({
  /** One sentence to begin with; or, with no questions, why there's nothing to quiz on. */
  intro: z.string().trim().min(1).max(L.speechChars),
  subject: Subject,
  conceptHints: z.array(z.string().trim().min(1).max(80)).max(5),
  questions: z.array(CheckQuestion).max(L.questions),
});
export type ScreenQuizModelResponse = z.infer<typeof ScreenQuizModelResponse>;

/** A question as the desktop app asks it: no key. */
export const ScreenQuizQuestion = z.object({
  checkId: z.uuid(),
  prompt: z.string().min(1).max(300),
  kind: CheckQuestion.shape.kind,
  choices: z.array(z.string().min(1).max(120)).max(4),
});
export type ScreenQuizQuestion = z.infer<typeof ScreenQuizQuestion>;

export const ScreenQuizReply = z.object({
  speech: z.string().min(1).max(L.speechChars),
  questions: z.array(ScreenQuizQuestion).max(L.questions),
});
export type ScreenQuizReply = z.infer<typeof ScreenQuizReply>;

/** `POST /api/screen/quiz/answer` (device token): an answer, typed, said or picked. */
export const ScreenQuizAnswerRequest = z.object({
  checkId: z.uuid(),
  answer: z.string().trim().min(1).max(L.answerChars),
});
export type ScreenQuizAnswerRequest = z.infer<typeof ScreenQuizAnswerRequest>;

export const ScreenQuizAnswerReply = z.object({
  correct: z.boolean(),
  /** Said and shown: right, or the answer and a short explanation. */
  speech: z.string().min(1).max(L.speechChars),
});
export type ScreenQuizAnswerReply = z.infer<typeof ScreenQuizAnswerReply>;
