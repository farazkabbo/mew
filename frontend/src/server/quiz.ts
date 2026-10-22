import "server-only";

import {
  QUIZ_GRADE_PROMPT,
  QuizGrade,
  type QuizGradeRequest,
  renderQuizGradeInput,
} from "@mew/shared";

import { geminiEnv } from "./env";
import { type GenerateStructured, generateStructured, type InputPart } from "./gemini";

const GRADE_TIMEOUT_MS = 15_000;

/** Grades an answer to a quiz question with the tutor model (rubric checker, brief §7). */
export async function gradeAnswer(
  request: QuizGradeRequest,
  generate: GenerateStructured = generateStructured,
): Promise<QuizGrade> {
  const input: InputPart[] = [{ type: "text", text: renderQuizGradeInput(request) }];
  if (request.image) input.push({ type: "image", png: request.image });
  return generate({
    model: geminiEnv().GEMINI_TUTOR_MODEL,
    system: QUIZ_GRADE_PROMPT.system,
    input,
    schema: QuizGrade,
    thinkingLevel: "low",
    maxOutputTokens: 1024,
    timeoutMs: GRADE_TIMEOUT_MS,
  });
}
