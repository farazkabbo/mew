/**
 * Show-then-You against the real models (K6/K7): `pnpm eval:solution` (needs GEMINI_API_KEY and
 * the API service running, for SymPy: `API_BASE_URL`, default http://127.0.0.1:8000). Each
 * problem must come back verified, with a verified Your Turn whose answer key is a final answer,
 * and every "why" short enough to say. Runs under `--conditions=react-server` like the others.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { inAnswerForm, type SolutionRequest, SOLUTION_LIMITS } from "@mew/shared";

const ROOT_ENV = path.resolve(import.meta.dirname, "../../.env.local");
if (existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);

if (!process.env.GEMINI_API_KEY) {
  console.log("eval:solution skipped — set GEMINI_API_KEY in .env.local.");
  process.exit(0);
}
const api = process.env.API_BASE_URL ?? "http://127.0.0.1:8000";
if (
  !(await fetch(`${api}/health`)
    .then((r) => r.ok)
    .catch(() => false))
) {
  console.log(`eval:solution skipped — start the API service (${api}) for SymPy.`);
  process.exit(0);
}

const { solve } = await import("../src/server/solution");

const CASES: { name: string; lines?: string[]; clipped?: string }[] = [
  { name: "two-step equation (the K6 acceptance)", lines: ["3x + 7 = 19"] },
  { name: "fractions", lines: ["\\frac{x}{4} - 2 = 3"] },
  {
    name: "physics with units",
    clipped: "A car accelerates from rest at 2 m/s² for 5 s. How far does it travel?",
  },
  { name: "chemistry", clipped: "Balance the equation: H2 + O2 → H2O" },
];

function request(c: (typeof CASES)[number]): SolutionRequest {
  return {
    utterance: "just give me the answer",
    recognizedLines: (c.lines ?? []).map((latex, i) => ({ lineId: `l${i}`, text: latex, latex })),
    pageImage: null,
    clippedText: c.clipped ? [{ source: "Homework", text: c.clipped }] : [],
    courseContext: [],
    concepts: [],
    variantOf: null,
  };
}

let failures = 0;
for (const c of CASES) {
  const started = performance.now();
  try {
    const result = await solve(request(c));
    const ms = Math.round(performance.now() - started);
    if (result.type !== "solution") {
      failures++;
      console.log(`✗ ${c.name} (${ms} ms): ${result.type}`);
      continue;
    }
    const s = result.solution;
    const key = s.yourTurn.answerKey.latex ?? s.yourTurn.answerKey.text;
    const problems = [
      !s.verification.passed && "not verified",
      !s.yourTurnVerified && "Your Turn not verified",
      s.yourTurnVerified &&
        s.verification.method === "sympy" &&
        !inAnswerForm(key, key) &&
        "key not final",
      s.steps.some((step) => step.why.split(/\s+/).length > SOLUTION_LIMITS.whyWords) &&
        "why too long",
    ].filter(Boolean);
    if (problems.length > 0) failures++;
    console.log(
      `${problems.length ? "✗" : "✓"} ${c.name} (${ms} ms, ${s.verification.method}): ${s.steps.length} steps → ${s.finalAnswer.text}; your turn: ${s.yourTurn.problem} = ${key}${problems.length ? ` — ${problems.join(", ")}` : ""}`,
    );
    for (const step of s.steps) console.log(`    ${step.latex ?? step.work}  —  ${step.why}`);
  } catch (error) {
    failures++;
    console.log(
      `✗ ${c.name}: ${error instanceof Error ? `${error.name}: ${error.message}` : "error"}`,
    );
  }
}
console.log(`${CASES.length - failures}/${CASES.length} verified`);
process.exit(failures > 0 ? 1 : 0);
