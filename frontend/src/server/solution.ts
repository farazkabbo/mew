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
  solutionChain,
  type VerifiedSolution,
  type VerificationMethod,
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

const checkMathRemote: CheckMath = async (steps) => {
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
): Promise<SolutionResponse> {
  if (request.variantOf) return variant(request, signal, deps);
  const model = geminiEnv().GEMINI_TUTOR_MODEL;
  let feedback: string | undefined;
  let best: VerifiedSolution | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const parts: InputPart[] = [{ type: "text", text: renderSolutionInput(request, feedback) }];
    if (request.pageImage) {
      parts.push({ type: "image", base64: request.pageImage, mimeType: "image/png" });
    }
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
 * Every line must follow from the one before, and the final answer must be verified: a chain
 * with an unreadable step in the middle still passes if nothing is wrong and the answer follows.
 */
async function maths(solution: FullSolution, checkMath: CheckMath): Promise<Check> {
  const { lines, positions } = solutionChain(solution);
  if (lines.length < 2 || positions.at(-1) !== solution.steps.length) {
    return { passed: false, feedback: "Give the problem and the final answer as LaTeX." };
  }
  const results = await checkMath(lines);
  if (!results) return { passed: false };
  const wrong = results.find((r) => r.verdict === "incorrect");
  if (wrong) {
    const failedStep = Math.max(0, positions[wrong.index] ?? 0);
    return {
      passed: false,
      failedStep,
      feedback: `Step ${failedStep + 1} (${lines[wrong.index]}) doesn't follow from the line before${wrong.detail ? `: ${wrong.detail}` : ""}.`,
    };
  }
  const last = results.find((r) => r.index === lines.length - 1);
  if (last?.verdict !== "correct") {
    return { passed: false, feedback: "The final answer couldn't be checked from the steps." };
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
  const results = await deps.checkMath([yourTurn.latex, key, yourTurn.latex]);
  const ok =
    results !== null &&
    results.filter((r) => r.index > 0).every((r) => r.verdict === "correct") &&
    results.length === 3;
  return {
    passed: ok,
    feedback: `The practice problem's answer key (${key}) isn't its solution.`,
  };
}
