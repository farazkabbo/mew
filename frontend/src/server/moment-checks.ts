import "server-only";

import {
  checkEvidence,
  CourseDetail,
  FsrsCard,
  type MomentCheckAnswer,
  MomentChecksDue,
  type MomentCheckResult,
  NotebookTreeView,
  solvedFor,
  withoutUnits,
} from "@mew/shared";
import { z } from "zod";

import { recordAttempt } from "./attempts";
import { coursesApi } from "./courses";
import { review } from "./learner";
import { gradeAnswer } from "./quiz";
import { type CheckMath, checkMathRemote } from "./solution";
import { userApi } from "./user-api";

/**
 * Answering a saved moment's check question (K8 §4.7). The question was shown first, without the
 * moment (retrieval practice); its key comes from the API only now, on this server. Graded by code
 * when it can be (a multiple choice by its choice, maths by SymPy, both ways, on its numbers),
 * by the quiz grader otherwise. Then FSRS reschedules the card (wrong: tomorrow), and the answer
 * counts as evidence for the course concepts it's about: correct with no peek and no hint is
 * `independent` (mastery), with one `with_hint`; wrong is logged as an attempt.
 */

const CheckWithKey = MomentChecksDue.shape.checks.element.extend({
  answerKey: z.string(),
  answerLatex: z.string().nullable(),
  fsrsState: FsrsCard.nullable(),
  reps: z.number().int().min(0),
});
type CheckWithKey = z.infer<typeof CheckWithKey>;

export type MomentCheckDeps = {
  checkMath: CheckMath;
  grade: typeof gradeAnswer;
  record: typeof recordAttempt;
  now: () => Date;
};

const defaultDeps: MomentCheckDeps = {
  checkMath: checkMathRemote,
  grade: gradeAnswer,
  record: recordAttempt,
  now: () => new Date(),
};

export function dueChecks() {
  return userApi("/v1/moments/checks/due", MomentChecksDue);
}

export async function answerCheck(
  checkId: string,
  answer: MomentCheckAnswer,
  deps: MomentCheckDeps = defaultDeps,
): Promise<MomentCheckResult> {
  const check = await userApi(`/v1/moments/checks/${checkId}`, CheckWithKey);
  const graded = await grade(check, answer.answer, deps);
  const evidence = checkEvidence({ ...answer, correct: graded.correct });
  const now = deps.now();
  const card = review(
    check.fsrsState,
    { correct: graded.correct, evidence: evidence ?? "independent" },
    now,
  );
  await userApi(`/v1/moments/checks/${checkId}`, z.undefined(), {
    method: "PATCH",
    body: { fsrsState: card, dueAt: card.due, reps: card.reps },
  });
  await logEvidence(check, graded.correct, evidence, deps).catch(() => undefined);
  return {
    correct: graded.correct,
    evidence,
    answerKey: check.answerKey,
    feedback: graded.feedback,
    nextDue: card.due,
  };
}

/** Right or wrong, and a sentence to say after (never before: the key comes with it). */
async function grade(
  check: CheckWithKey,
  reply: string,
  deps: MomentCheckDeps,
): Promise<{ correct: boolean; feedback: string }> {
  const right = { correct: true, feedback: "That's it." };
  const wrong = {
    correct: false,
    feedback: "Not quite. Here's the answer; this one comes back soon.",
  };
  if (check.kind === "mcq") {
    const same = reply.trim().toLowerCase() === check.answerKey.trim().toLowerCase();
    return same ? right : wrong;
  }
  if (check.answerLatex) {
    const proved = await sameMaths(check.answerLatex, reply, deps.checkMath);
    if (proved !== null) return proved ? right : wrong;
  }
  const verdict = await deps.grade({
    concept: check.conceptHints[0] ?? "the idea",
    question: check.prompt,
    expected: check.answerKey,
    recognized: [],
    spoken: reply.slice(0, 500),
    image: null,
  });
  return { correct: verdict.verdict === "correct", feedback: verdict.feedback };
}

/**
 * Whether a typed answer equals the key, by SymPy (each follows from the other), on its numbers;
 * "3" for the key "x = 3" counts as "x = 3". Null when SymPy can't tell (the grader decides).
 */
async function sameMaths(
  key: string,
  reply: string,
  checkMath: CheckMath,
): Promise<boolean | null> {
  const expected = withoutUnits(key);
  const variable = solvedFor(expected);
  const given = withoutUnits(reply);
  const line = variable && !given.includes("=") ? `${variable} = ${given}` : given;
  const results = await checkMath([expected, line, expected]);
  if (!results || results.length !== 3) return null;
  const verdicts = results.slice(1).map((r) => r.verdict);
  if (verdicts.every((v) => v === "correct")) return true;
  if (verdicts.includes("incorrect")) return false;
  return null;
}

/** The course concepts a check is about: its hints, matched to its notebook's course. */
async function logEvidence(
  check: CheckWithKey,
  correct: boolean,
  evidence: ReturnType<typeof checkEvidence>,
  deps: MomentCheckDeps,
): Promise<void> {
  if (!check.nodeId || check.conceptHints.length === 0) return;
  const { nodes } = await userApi("/v1/notebooks/tree", NotebookTreeView);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let node = byId.get(check.nodeId);
  while (node?.parentId) node = byId.get(node.parentId);
  const courseId = node?.courseId;
  if (!courseId) return;
  const course = await coursesApi(`/v1/courses/${courseId}`, CourseDetail);
  const hints = check.conceptHints.map((h) => h.toLowerCase());
  const concepts = course.concepts
    .filter((c) => {
      const title = c.title.toLowerCase();
      return hints.some((h) => title === h || title.includes(h) || h.includes(title));
    })
    .slice(0, 3);
  for (const concept of concepts) {
    await deps.record(courseId, {
      conceptId: concept.id,
      correct,
      evidence: evidence ?? "independent",
      source: "moment_check",
    });
  }
}

export function clearChecks() {
  return userApi("/v1/moments/checks", z.undefined(), { method: "DELETE" });
}
