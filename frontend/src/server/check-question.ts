import "server-only";

import {
  type CheckQuestion,
  checkBalance,
  looksLikeReaction,
  solvedFor,
  unsafeReasons,
  withoutUnits,
} from "@mew/shared";

import { type CheckMath, checkMathRemote } from "./solution";

/**
 * A moment's check question, made safe to keep (K8 §4.7): "the answer key is verified with the
 * checker router before it's stored. If verification fails, store no question." Maths keys are
 * checked by SymPy against their problem (both ways, on their numbers, solved for the variable,
 * like a Your Turn), chemistry keys by balance, a multiple choice by its key being one of the
 * choices. A key in words (a "why" question) is kept: the grader judges answers to it later. Any
 * text that fails the rule-based safety check means no question.
 */
export async function verifiedCheckQuestion(
  question: CheckQuestion | null,
  checkMath: CheckMath = checkMathRemote,
): Promise<CheckQuestion | null> {
  if (!question) return null;
  const texts = [question.prompt, question.answerKey, ...question.choices];
  if (texts.some((text) => unsafeReasons(text).length > 0)) return null;

  if (question.kind === "mcq") {
    const key = question.answerKey.trim().toLowerCase();
    const choices = question.choices.map((c) => c.trim().toLowerCase());
    if (choices.length < 2 || !choices.includes(key)) return null;
  }
  const checked = { ...question, choices: question.kind === "mcq" ? question.choices : [] };

  const key = question.answerLatex;
  if (!key) return checked;
  if (looksLikeReaction(key)) return checkBalance(key).verdict === "correct" ? checked : null;
  const problem = question.problemLatex;
  if (!problem || (key.includes("=") && !solvedFor(key))) return null;
  const steps = [withoutUnits(problem), withoutUnits(key), withoutUnits(problem)];
  const results = await checkMath(steps);
  const proved =
    results !== null &&
    results.length === 3 &&
    results.filter((r) => r.index > 0).every((r) => r.verdict === "correct");
  return proved ? checked : null;
}
