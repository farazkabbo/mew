import { z } from "zod";

import { COURSE_LIMITS, CourseExcerpt } from "./course";
import { SketchFigure } from "./screen";
import { ClippedText, RecognizedLine, Subject, TUTOR_LIMITS } from "./tutor";

/**
 * Show-then-You (K6, docs/NOTEBOOKS_K.md §6): when the student asks for the answer itself, the
 * tutor works the problem step by step, each step with its reason, after code has verified it;
 * then a similar problem ("Your turn") with a verified answer key for the student to do alone.
 */
export const SOLUTION_LIMITS = {
  /** Problem, steps and answer fit one SymPy check (8 lines). */
  steps: 6,
  workChars: 120,
  latexChars: 200,
  /** "why" is spoken: at most 20 words. */
  whyWords: 20,
  whyChars: 200,
  problemChars: 500,
  skillChars: 80,
  concepts: 40,
  conceptIds: 3,
} as const;

const Text = (max: number) => z.string().trim().min(1).max(max);
/** Empty counts as none (a model sometimes writes "" for null). */
const Latex = z.string().trim().max(SOLUTION_LIMITS.latexChars).nullable();

/** One line of maths or words, with its LaTeX when it has some (null when it's only words). */
const Written = z.object({ text: Text(SOLUTION_LIMITS.problemChars), latex: Latex });

export const SolutionStep = z.object({
  /** What is written, as words ("Subtract 7 from both sides" is `why`, not this). */
  work: Text(SOLUTION_LIMITS.workChars),
  latex: Latex,
  /** Said aloud while the step is written: the reason, not the operation. */
  why: Text(SOLUTION_LIMITS.whyChars),
  /** A figure drawn before the step, when one helps (K5): null otherwise. */
  figure: SketchFigure.nullable(),
});
export type SolutionStep = z.infer<typeof SolutionStep>;

export const YourTurn = z.object({
  problem: Text(SOLUTION_LIMITS.problemChars),
  latex: Latex,
  answerKey: Written,
  /** The skill it practises, in a few words ("solving two-step linear equations"). */
  skill: Text(SOLUTION_LIMITS.skillChars),
  /** Course concepts it practises: ids from the request's list only (checked). */
  conceptIds: z.array(z.string().max(40)).max(SOLUTION_LIMITS.conceptIds),
});
export type YourTurn = z.infer<typeof YourTurn>;

/** What the full-solution model returns (prompt `full-solution`). */
export const FullSolution = z.object({
  problem: Written,
  subject: Subject,
  steps: z.array(SolutionStep).min(1).max(SOLUTION_LIMITS.steps),
  finalAnswer: Written,
  yourTurn: YourTurn,
});
export type FullSolution = z.infer<typeof FullSolution>;

export const VerificationMethod = z.enum(["sympy", "chem_balance", "code", "rubric"]);
export type VerificationMethod = z.infer<typeof VerificationMethod>;

/** Added by code after verification, never by the model. */
export const VerifiedSolution = FullSolution.extend({
  verification: z.object({
    method: VerificationMethod,
    passed: z.boolean(),
    /** The first step that failed (0-based; steps.length = the final answer). */
    failedStep: z.number().int().min(0).optional(),
  }),
  yourTurnVerified: z.boolean(),
});
export type VerifiedSolution = z.infer<typeof VerifiedSolution>;

/** A course concept the Your Turn may practise (ids are checked against this list). */
export const SolutionConcept = z.object({ id: z.uuid(), title: z.string().min(1).max(120) });

/** `POST /api/solution`: what the notebook knows about the problem. */
export const SolutionRequest = z.object({
  /** "Just give me the answer", as the student said it. */
  utterance: z.string().max(500),
  /** The student's lines near where they're working (the problem, and any attempt). */
  recognizedLines: z.array(RecognizedLine).max(TUTOR_LIMITS.recognizedLines),
  /** PNG (base64) of the work around the problem, if any. */
  pageImage: z.string().max(TUTOR_LIMITS.imageBase64Chars).nullable(),
  clippedText: z.array(ClippedText).max(TUTOR_LIMITS.clippedTexts).default([]),
  courseContext: z.array(CourseExcerpt).max(COURSE_LIMITS.excerptsPerTurn).default([]),
  concepts: z.array(SolutionConcept).max(SOLUTION_LIMITS.concepts).default([]),
  /** "One more": a new Your Turn of the same skill, without solving anything. */
  variantOf: YourTurn.pick({ problem: true, skill: true }).nullable().default(null),
});
export type SolutionRequest = z.infer<typeof SolutionRequest>;

export const SolutionResponse = z.discriminatedUnion("type", [
  z.object({ type: z.literal("solution"), solution: VerifiedSolution }),
  /** A new Your Turn ("One more"), verified. */
  z.object({ type: z.literal("your_turn"), yourTurn: YourTurn }),
  /**
   * Verification failed twice (or couldn't run): no confident wrong answer is shown. `speech`
   * says what's uncertain; the tutor falls back to hints.
   */
  z.object({ type: z.literal("uncertain"), speech: z.string().min(1).max(300) }),
]);
export type SolutionResponse = z.infer<typeof SolutionResponse>;

/** "why" kept to 20 words (cut at a word, with "…"): it's said while the step is written. */
export function clipWhy(why: string): string {
  const words = why.split(/\s+/).filter(Boolean);
  if (words.length <= SOLUTION_LIMITS.whyWords) return words.join(" ");
  return `${words
    .slice(0, SOLUTION_LIMITS.whyWords)
    .join(" ")
    .replace(/[,;:.!?]+$/, "")}…`;
}

/**
 * The lines SymPy checks, in order: the problem, each step and the final answer, skipping any
 * without LaTeX. `positions[i]` is which solution line check line i is (-1 the problem, steps
 * 0…n-1, n the final answer).
 */
export function solutionChain(solution: Pick<FullSolution, "problem" | "steps" | "finalAnswer">): {
  lines: string[];
  positions: number[];
} {
  const lines: string[] = [];
  const positions: number[] = [];
  const add = (latex: string | null, position: number) => {
    if (latex) {
      lines.push(latex);
      positions.push(position);
    }
  };
  add(solution.problem.latex, -1);
  solution.steps.forEach((step, i) => add(step.latex, i));
  add(solution.finalAnswer.latex, solution.steps.length);
  return { lines, positions };
}
