import type { FullSolution, MathCheckResponse, SolutionRequest, YourTurn } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

import type { GenerateStructured } from "./gemini";
import { type CheckMath, methodFor, solve } from "./solution";

vi.stubEnv("GEMINI_API_KEY", "test-key");

const REQUEST: SolutionRequest = {
  utterance: "just give me the answer",
  recognizedLines: [{ lineId: "l1", text: "3x + 7 = 19", latex: "3x + 7 = 19" }],
  pageImage: null,
  clippedText: [],
  courseContext: [],
  concepts: [{ id: "11111111-1111-4111-8111-111111111111", title: "Linear equations" }],
  variantOf: null,
};

const YOUR_TURN: YourTurn = {
  problem: "Solve 5x − 4 = 21",
  latex: "5x - 4 = 21",
  answerKey: { text: "x = 5", latex: "x = 5" },
  skill: "two-step linear equations",
  conceptIds: ["11111111-1111-4111-8111-111111111111", "not-in-the-course"],
};

const SOLUTION: FullSolution = {
  problem: { text: "Solve 3x + 7 = 19", latex: "3x + 7 = 19" },
  subject: "math",
  steps: [
    {
      work: "3x = 12",
      latex: "3x = 12",
      why: "Subtract 7 from both sides, to undo the plus 7.",
      figure: null,
    },
    { work: "x = 4", latex: "x = 4", why: "Divide both sides by 3, to get x alone.", figure: null },
  ],
  finalAnswer: { text: "x = 4", latex: "x = 4" },
  yourTurn: YOUR_TURN,
};

/** A SymPy stand-in: a line is wrong when it's in `wrong`, else correct (index 0: first line). */
function checker(wrong: string[] = []): CheckMath & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (steps: string[]) => {
    calls.push(steps);
    return steps.map((latex, index): MathCheckResponse["results"][number] =>
      index === 0
        ? { index, verdict: "unknown", reason: "first_line" }
        : wrong.includes(latex)
          ? { index, verdict: "incorrect", reason: "not_implied", detail: "x = 5 is lost" }
          : { index, verdict: "correct", reason: "implied" },
    );
  }) as CheckMath & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

function generator(...outputs: unknown[]) {
  const generate = vi.fn(async () => outputs.shift()) as unknown as GenerateStructured & {
    mock: { calls: { input: unknown }[][] };
  };
  return generate;
}

describe("solve", () => {
  it("returns a solution only after SymPy has verified every step and the Your Turn", async () => {
    const checkMath = checker();
    const result = await solve(REQUEST, undefined, { generate: generator(SOLUTION), checkMath });
    expect(result.type).toBe("solution");
    if (result.type !== "solution") return;
    expect(result.solution.verification).toEqual({ method: "sympy", passed: true });
    expect(result.solution.yourTurnVerified).toBe(true);
    // Problem → steps → answer, then the answer key both ways (its only solution).
    expect(checkMath.calls).toEqual([
      ["3x + 7 = 19", "3x = 12", "x = 4", "x = 4"],
      ["5x - 4 = 21", "x = 5", "5x - 4 = 21"],
    ]);
    // Concept ids come from the course only.
    expect(result.solution.yourTurn.conceptIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("regenerates once with the failure, then shows the verified solution", async () => {
    const wrong = {
      ...SOLUTION,
      steps: [{ ...SOLUTION.steps[0], latex: "3x = 26" }, SOLUTION.steps[1]],
    } as FullSolution;
    const generate = generator(wrong, SOLUTION);
    const result = await solve(REQUEST, undefined, {
      generate,
      checkMath: checker(["3x = 26"]),
    });
    expect(result.type).toBe("solution");
    const second = JSON.stringify(generate.mock.calls[1]?.[0]?.input);
    expect(second).toContain("Step 1 (3x = 26)");
  });

  it("never shows a solution that fails twice: it's uncertain, and the tutor gives hints", async () => {
    const wrong = { ...SOLUTION, finalAnswer: { text: "x = 5", latex: "x = 5" } };
    const result = await solve(REQUEST, undefined, {
      generate: generator(wrong, wrong),
      checkMath: checker(["x = 5"]),
    });
    expect(result).toEqual({ type: "uncertain", speech: expect.stringMatching(/not sure/) });
  });

  it("shows a verified solution without a Your Turn whose answer key is wrong", async () => {
    const badTurn = {
      ...SOLUTION,
      yourTurn: { ...YOUR_TURN, answerKey: { text: "x = 6", latex: "x = 6" } },
    };
    const result = await solve(REQUEST, undefined, {
      generate: generator(badTurn, badTurn),
      checkMath: checker(["x = 6"]),
    });
    expect(result.type === "solution" && result.solution.yourTurnVerified).toBe(false);
  });

  it("refuses a Your Turn whose answer key isn't a final answer (5x = 25 for x = 5)", async () => {
    const unsolved = {
      ...SOLUTION,
      yourTurn: { ...YOUR_TURN, answerKey: { text: "5x = 25", latex: "5x = 25" } },
    };
    const generate = generator(unsolved, SOLUTION);
    const result = await solve(REQUEST, undefined, { generate, checkMath: checker() });
    // SymPy would call the two equivalent; the student could never finish against it.
    expect(result.type === "solution" && result.solution.yourTurn.answerKey.latex).toBe("x = 5");
    expect(JSON.stringify(generate.mock.calls[1]?.[0]?.input)).toContain("solved for its variable");
  });

  it("is uncertain when the checker can't be reached", async () => {
    const result = await solve(REQUEST, undefined, {
      generate: generator(SOLUTION, SOLUTION),
      checkMath: async () => null,
    });
    expect(result.type).toBe("uncertain");
  });

  it("checks chemistry by balance and other subjects by a rubric", async () => {
    expect(methodFor({ ...SOLUTION, subject: "chemistry" })).toBe("chem_balance");
    expect(methodFor({ ...SOLUTION, subject: "biology" })).toBe("rubric");
    const unbalanced = {
      ...SOLUTION,
      subject: "chemistry" as const,
      finalAnswer: { text: "H2 + O2 -> H2O", latex: null },
    };
    const result = await solve(REQUEST, undefined, {
      generate: generator(unbalanced, unbalanced),
      checkMath: checker(),
    });
    expect(result.type).toBe("uncertain");
  });

  it("makes a verified One more", async () => {
    const result = await solve(
      { ...REQUEST, variantOf: { problem: YOUR_TURN.problem, skill: YOUR_TURN.skill } },
      undefined,
      {
        generate: generator({
          ...YOUR_TURN,
          latex: "2x + 1 = 9",
          answerKey: { text: "x = 4", latex: "x = 4" },
        }),
        checkMath: checker(),
      },
    );
    expect(result.type).toBe("your_turn");
  });
});
