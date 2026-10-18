import { QuizGrade, type QuizGradeRequest } from "@mew/shared";

/**
 * Asks the server to grade a quiz answer. Null when grading isn't available (no model
 * configured, model failure, offline): the quiz then lets the student grade themselves.
 */
export async function gradeRemote(
  request: QuizGradeRequest,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<QuizGrade | null> {
  try {
    const response = await fetchImpl("/api/quiz/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return QuizGrade.parse(await response.json());
  } catch {
    return null;
  }
}
