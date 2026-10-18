import type { ConceptStatus, QuizVerdict } from "@mew/shared";
import { create } from "zustand";

export type QuizQuestion = {
  conceptId: string;
  conceptTitle: string;
  question: string;
  answer: string;
  hint: string;
  /** False for the fallback recall question (no practice questions in the lesson). */
  fromLesson: boolean;
};

/**
 * - loading: choosing a concept and fetching its lesson
 * - asking: waiting for the student's answer (on the page, or out loud)
 * - grading: the answer is being checked
 * - self: no grader available: the student compares with the model answer themselves
 * - done: this question is finished (recorded); "Next" moves on
 * - finished: nothing left to ask, or the quiz couldn't start
 */
export type QuizPhase = "loading" | "asking" | "grading" | "self" | "done" | "finished";

export type QuizFeedback = { verdict: QuizVerdict; text: string };

type QuizState = {
  active: boolean;
  courseId: string | null;
  courseTitle: string;
  phase: QuizPhase;
  question: QuizQuestion | null;
  hintShown: boolean;
  revealed: boolean;
  /** Feedback on the latest check of this question. */
  feedback: QuizFeedback | null;
  /** The concept's status after this question was recorded. */
  status: ConceptStatus | null;
  /** Questions finished and answered correctly this session. */
  asked: number;
  correct: number;
  message: string | null;
};

export const INITIAL_QUIZ: QuizState = {
  active: false,
  courseId: null,
  courseTitle: "",
  phase: "loading",
  question: null,
  hintShown: false,
  revealed: false,
  feedback: null,
  status: null,
  asked: 0,
  correct: 0,
  message: null,
};

export const useQuiz = create<QuizState>()(() => INITIAL_QUIZ);
