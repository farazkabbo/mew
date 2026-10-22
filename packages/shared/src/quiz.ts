import { z } from "zod";

import { MEW_LIMITS } from "./mew";

/** "Quiz me" (M8): the tutor asks practice questions in the notebook and grades the answers. */
export const QUIZ_LIMITS = {
  conceptChars: 120,
  questionChars: 400,
  answerChars: 600,
  feedbackChars: 240,
  noteChars: 30,
  recognizedLines: 8,
  lineChars: 300,
  /** Same budget as the tutor's page image (tutor.ts imports this module, so not shared). */
  imageBase64Chars: 1_500_000,
} as const;

/** The question being answered, as the tutor sees it (never the expected answer). */
export const QuizContext = z.object({
  concept: z.string().max(QUIZ_LIMITS.conceptChars),
  question: z.string().max(QUIZ_LIMITS.questionChars),
});
export type QuizContext = z.infer<typeof QuizContext>;

/** A student's answer to grade: what they wrote (image and recognised text) and said. */
export const QuizGradeRequest = z
  .object({
    concept: z.string().trim().min(1).max(QUIZ_LIMITS.conceptChars),
    question: z.string().trim().min(1).max(QUIZ_LIMITS.questionChars),
    expected: z.string().max(QUIZ_LIMITS.answerChars),
    recognized: z.array(z.string().max(QUIZ_LIMITS.lineChars)).max(QUIZ_LIMITS.recognizedLines),
    spoken: z.string().max(MEW_LIMITS.utteranceChars),
    /** PNG (base64, no data: prefix) of the lines written since the question was asked. */
    image: z.string().max(QUIZ_LIMITS.imageBase64Chars).nullable(),
  })
  .strict();
export type QuizGradeRequest = z.infer<typeof QuizGradeRequest>;

export const QuizVerdict = z.enum(["correct", "partly", "incorrect", "unreadable"]);
export type QuizVerdict = z.infer<typeof QuizVerdict>;

/** The model's grade. Every field is required (defaults would let the model skip them). */
export const QuizGrade = z.object({
  verdict: QuizVerdict,
  /** Said aloud: one or two short sentences, a hint rather than the answer when it's wrong. */
  feedback: z.string().min(1).max(QUIZ_LIMITS.feedbackChars),
  /** Written next to a wrong answer: 1–4 words ("sign?", "units?"). */
  note: z.string().max(QUIZ_LIMITS.noteChars),
});
export type QuizGrade = z.infer<typeof QuizGrade>;
