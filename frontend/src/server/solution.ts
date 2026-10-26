import "server-only";

import {
  checkBalance,
  clipWhy,
  FULL_SOLUTION_PROMPT,
  FullSolution,
  looksLikeReaction,
  MathCheckResponse,
  renderRubricInput,
  renderSolutionInput,
  renderVariantInput,
  SOLUTION_RUBRIC_PROMPT,
  type SolutionRequest,
  type SolutionResponse,
  numbersChain,
  solutionChain,
  solvedFor,
  type VerifiedSolution,
  type VerificationMethod,
  withoutUnits,
  YOUR_TURN_VARIANT_PROMPT,
  YourTurn,
} from "@mew/shared";
import { z } from "zod";

import { apiFetch } from "./api-client";
import { geminiEnv, verifierModel } from "./env";
import { type GenerateStructured, generateStructured, type InputPart } from "./gemini";

const SOLUTION_TIMEOUT_MS = 30_000;
const UNCERTAIN =
  "I worked it out but couldn't check my answer, so I won't give you one I'm not sure of. Let's do it together: what's the first step?";

/** SymPy on the API service: does each line follow from the one before? */
export type CheckMath = (steps: string[]) => Promise<MathCheckResponse["results"] | null>;

export type SolutionDeps = { generate: GenerateStructured; checkMath: CheckMath };

export const checkMathRemote: CheckMath = async (steps) => {
  try {
    const result = await apiFetch("/v1/check/math", MathCheckResponse, {
      method: "POST",
      body: { steps },
      timeoutMs: 8000,
    });
    return result.results;
  } catch {
    return null;
  }
};

const defaultDeps: SolutionDeps = { generate: generateStructured, checkMath: checkMathRemote };

const Rubric = z.object({
  passed: z.boolean(),
  failedStep: z.number().int().min(0).nullable(),
  yourTurnPassed: z.boolean(),
  reason: z.string().max(300),
});

type Check = { passed: boolean; failedStep?: number; feedback?: string };

/**
 * Show-then-You (K6 §6.1 step 2): the model solves, code verifies, and nothing unverified is
 * shown. A failed check is fed back for one more try; if that fails too, the answer is
 * "uncertain" and the tutor falls back to hints. The Your Turn's answer key is verified the same
 * way; an unverified one isn't offered.
 */
export async function solve(
  request: SolutionRequest,
  signal?: AbortSignal,
  deps: SolutionDeps = defaultDeps,
  /** The problem as a picture other than the notebook page (the screen's focus image, K7). */
  image?: Extract<InputPart, { type: "image" }>,
): Promise<SolutionResponse> {
  if (request.variantOf) return variant(request, signal, deps);
  const model = geminiEnv().GEMINI_TUTOR_MODEL;
  const picture: InputPart | null =
    image ??
    (request.pageImage
      ? { type: "image", base64: request.pageImage, mimeType: "image/png" }
      : null);
  let feedback: string | undefined;
  let best: VerifiedSolution | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = renderSolutionInput(
      request,
      feedback,
      image && "attached: what the student circled on their screen, with their marks",
    );
    const parts: InputPart[] = [{ type: "text", text }];
    if (picture) parts.push(picture);
    const raw = await deps.generate({
      model,
      system: FULL_SOLUTION_PROMPT.system,
      input: parts,
      schema: FullSolution,
      thinkingLevel: "medium",
      maxOutputTokens: 4096,
      timeoutMs: SOLUTION_TIMEOUT_MS,
      ...(signal && { signal }),
    });
    const solution = tidy(raw, request);
    const { method, solved, yourTurn } = await verify(solution, request, deps, signal);
    const verified: VerifiedSolution = {
      ...solution,
      verification: {
        method,
        passed: solved.passed,
        ...(solved.failedStep !== undefined && { failedStep: solved.failedStep }),
      },
      yourTurnVerified: yourTurn.passed,
    };
    if (solved.passed && yourTurn.passed) return { type: "solution", solution: verified };
    if (solved.passed) best = verified;
    feedback = [solved.feedback, yourTurn.passed ? null : yourTurn.feedback]
      .filter(Boolean)
      .join(" ");
  }
  // The solution checked out but no Your Turn did: show it, without one.
  if (best) return { type: "solution", solution: best };
  return { type: "uncertain", speech: UNCERTAIN };
}

async function variant(
  request: SolutionRequest,
  signal: AbortSignal | undefined,
  deps: SolutionDeps,
): Promise<SolutionResponse> {
  let feedback: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await deps.generate({
      model: geminiEnv().GEMINI_TUTOR_MODEL,
      system: YOUR_TURN_VARIANT_PROMPT.system,
      input: renderVariantInput(request, feedback),
      schema: YourTurn,
      thinkingLevel: "low",
      maxOutputTokens: 1024,
      timeoutMs: SOLUTION_TIMEOUT_MS,
      ...(signal && { signal }),
    });
    const yourTurn = { ...raw, conceptIds: knownConcepts(raw.conceptIds, request) };
    const check = await verifyYourTurn(yourTurn, deps);
    if (check.passed) return { type: "your_turn", yourTurn };
    feedback = check.feedback;
  }
  return { type: "uncertain", speech: "I couldn't make another one I'm sure of. Try the review." };
}

/** Code's view of the model's output: words clipped, concept ids only from the course. */
function tidy(solution: FullSolution, request: SolutionRequest): FullSolution {
  return {
    ...solution,
    steps: solution.steps.map((step) => ({ ...step, why: clipWhy(step.why) })),
    yourTurn: {
      ...solution.yourTurn,
      conceptIds: knownConcepts(solution.yourTurn.conceptIds, request),
    },
  };
}

function knownConcepts(ids: readonly string[], request: SolutionRequest): string[] {
  const known = new Set(request.concepts.map((c) => c.id));
  return [...new Set(ids.filter((id) => known.has(id)))];
}

/** The checker for the subject (brief §6.1 step 2). */
export function methodFor(solution: FullSolution): VerificationMethod {
  if (solution.subject === "chemistry" || looksLikeReaction(solution.finalAnswer.latex ?? "")) {
    return "chem_balance";
  }
  if (solution.subject === "math" || solution.subject === "physics") return "sympy";
  // Code would run in the student's browser (Pyodide); here it gets the rubric check.
  return "rubric";
}

async function verify(
  solution: FullSolution,
  request: SolutionRequest,
  deps: SolutionDeps,
  signal?: AbortSignal,
): Promise<{ method: VerificationMethod; solved: Check; yourTurn: Check }> {
  const method = methodFor(solution);
  if (method === "rubric") {
    const rubric = await deps
      .generate({
        model: verifierModel(),
        system: SOLUTION_RUBRIC_PROMPT.system,
        input: renderRubricInput(solution, request),
        schema: Rubric,
        thinkingLevel: "medium",
        maxOutputTokens: 512,
        timeoutMs: SOLUTION_TIMEOUT_MS,
        ...(signal && { signal }),
      })
      .catch(() => null);
    if (!rubric) return { method, solved: { passed: false }, yourTurn: { passed: false } };
    return {
      method,
      solved: {
        passed: rubric.passed,
        ...(rubric.failedStep !== null && { failedStep: rubric.failedStep }),
        feedback: rubric.passed ? "" : `A check found a mistake: ${rubric.reason}`,
      },
      yourTurn: { passed: rubric.yourTurnPassed, feedback: "The practice answer key was wrong." },
    };
  }
  const solved =
    method === "chem_balance" ? chemistry(solution) : await maths(solution, deps.checkMath);
  return { method, solved, yourTurn: await verifyYourTurn(solution.yourTurn, deps) };
}

/**
 * Every checked line must be proved to follow from the one before, up to the final answer: an
 * unreadable line breaks the proof, so it fails too (and the retry is told how to write it).
 * Physics is checked on its numbers (`numbersChain`, K7): from the formula with its values put in.
 */
async function maths(solution: FullSolution, checkMath: CheckMath): Promise<Check> {
  const physics = solution.subject === "physics";
  const chain = physics ? numbersChain(solution) : solutionChain(solution);
  if (!chain || chain.lines.length < 2 || chain.positions.at(-1) !== solution.steps.length) {
    return {
      passed: false,
      feedback: physics
        ? "Write the formula with the problem's numbers put in as a step of its own, then the arithmetic, all as LaTeX."
        : "Give the problem and the final answer as LaTeX.",
    };
  }
  const { lines, positions } = chain;
  const results = await checkMath(lines);
  if (!results) return { passed: false };
  const failed = results.find((r) => r.index > 0 && r.verdict !== "correct");
  if (failed || results.length !== lines.length) {
    const index = failed?.index ?? lines.length - 1;
    const failedStep = Math.max(0, positions[index] ?? 0);
    const line = lines[index] ?? "";
    return {
      passed: false,
      failedStep,
      feedback:
        failed?.verdict === "incorrect"
          ? `Step ${failedStep + 1} (${line}) doesn't follow from the line before${failed.detail ? `: ${failed.detail}` : ""}.`
          : `Step ${failedStep + 1} (${line}) couldn't be checked: write each line as plain LaTeX, with \\cdot for multiplication (0 \\cdot 5, not 0(5)).`,
    };
  }
  return { passed: true };
}

function chemistry(solution: FullSolution): Check {
  const equation = solution.finalAnswer.latex ?? solution.finalAnswer.text;
  const result = checkBalance(equation);
  if (result.verdict === "correct") return { passed: true };
  return {
    passed: false,
    failedStep: solution.steps.length,
    feedback: `The final equation isn't balanced${result.verdict === "incorrect" ? `: ${result.detail}` : ""}.`,
  };
}

/** The answer key is the problem's only solution: each follows from the other. */
async function verifyYourTurn(yourTurn: YourTurn, deps: SolutionDeps): Promise<Check> {
  const key = yourTurn.answerKey.latex;
  if (looksLikeReaction(key ?? yourTurn.answerKey.text)) {
    const ok = checkBalance(key ?? yourTurn.answerKey.text).verdict === "correct";
    return { passed: ok, feedback: "The practice equation's answer isn't balanced." };
  }
  if (!yourTurn.latex || !key) {
    return { passed: false, feedback: "Give the practice problem and its answer as LaTeX." };
  }
  // The student finishes by writing the answer in this form, so it must be a final answer.
  if (key.includes("=") && !solvedFor(key)) {
    return {
      passed: false,
      feedback: `The practice answer key (${key}) must be solved for its variable, like "x = 5".`,
    };
  }
  // On its numbers: "s = 24 m" is the answer to s = ½ · 3 · 4² (K7).
  const problem = withoutUnits(yourTurn.latex);
  const results = await deps.checkMath([problem, withoutUnits(key), problem]);
  const ok =
    results !== null &&
    results.filter((r) => r.index > 0).every((r) => r.verdict === "correct") &&
    results.length === 3;
  return {
    passed: ok,
    feedback: `The practice problem's answer key (${key}) isn't its solution.`,
  };
}
