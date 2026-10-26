import type { CheckQuestion, MathCheckResponse } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

import { verifiedCheckQuestion } from "./check-question";
import type { CheckMath } from "./solution";

const WHY: CheckQuestion = {
  kind: "short",
  prompt: "Why is the slope of a velocity–time graph the acceleration?",
  choices: [],
  answerKey: "Acceleration is how fast velocity changes, and the slope is that change per second.",
  answerLatex: null,
  problemLatex: null,
};
const SOLVE: CheckQuestion = {
  kind: "work",
  prompt: "Solve 2x = 6.",
  choices: [],
  answerKey: "x = 3",
  answerLatex: "x = 3",
  problemLatex: "2x = 6",
};

/** SymPy, faked: lines in `wrong` don't follow; everything else does. */
function sympy(wrong: string[] = []): CheckMath & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = vi.fn((steps: string[]) => {
    calls.push(steps);
    return Promise.resolve(
      steps.map((step, index): MathCheckResponse["results"][number] =>
        index === 0
          ? { index, verdict: "unknown", reason: "first_line" }
          : { index, verdict: wrong.includes(step) ? "incorrect" : "correct", reason: "checked" },
      ),
    );
  }) as unknown as CheckMath & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

describe("a moment's check question (K8 §4.7)", () => {
  it("keeps a question answered in words: the grader judges it later", async () => {
    expect(await verifiedCheckQuestion(WHY, sympy())).toEqual(WHY);
  });

  it("keeps a maths question only when SymPy proves its key", async () => {
    const checker = sympy();
    expect(await verifiedCheckQuestion(SOLVE, checker)).toEqual(SOLVE);
    expect(checker.calls).toEqual([["2x = 6", "x = 3", "2x = 6"]]);

    // A wrong key is never stored.
    expect(
      await verifiedCheckQuestion({ ...SOLVE, answerLatex: "x = 4" }, sympy(["x = 4"])),
    ).toBeNull();
    // Nor one that can't be checked (SymPy unreachable), nor one that isn't a final answer.
    expect(await verifiedCheckQuestion(SOLVE, () => Promise.resolve(null))).toBeNull();
    expect(await verifiedCheckQuestion({ ...SOLVE, answerLatex: "2x = 6" }, sympy())).toBeNull();
    expect(await verifiedCheckQuestion({ ...SOLVE, problemLatex: null }, sympy())).toBeNull();
  });

  it("checks a physics key on its numbers and a chemistry key by balance", async () => {
    const checker = sympy();
    const physics = {
      ...SOLVE,
      answerLatex: String.raw`s = 24 \text{ m}`,
      problemLatex: String.raw`s = \frac{1}{2} \cdot 3 \cdot 4^2`,
    };
    expect(await verifiedCheckQuestion(physics, checker)).toEqual(physics);
    expect(checker.calls[0]?.[1]).toBe("s = 24");

    const balanced = { ...SOLVE, answerLatex: "2H2 + O2 -> 2H2O", problemLatex: null };
    expect(await verifiedCheckQuestion(balanced, sympy())).toEqual(balanced);
    const unbalanced = { ...balanced, answerLatex: "H2 + O2 -> H2O" };
    expect(await verifiedCheckQuestion(unbalanced, sympy())).toBeNull();
  });

  it("needs a multiple choice's key among its choices", async () => {
    const mcq: CheckQuestion = {
      ...WHY,
      kind: "mcq",
      choices: ["Constant speed", "Speeding up"],
      answerKey: "speeding up",
    };
    expect(await verifiedCheckQuestion(mcq, sympy())).toEqual(mcq);
    expect(await verifiedCheckQuestion({ ...mcq, answerKey: "Slowing down" }, sympy())).toBeNull();
    expect(await verifiedCheckQuestion({ ...mcq, choices: ["Speeding up"] }, sympy())).toBeNull();
    // Choices only belong to a multiple choice.
    expect(
      (await verifiedCheckQuestion({ ...WHY, choices: ["a", "b"] }, sympy()))?.choices,
    ).toEqual([]);
  });

  it("drops a question with unsafe words", async () => {
    const unsafe = { ...WHY, prompt: "Open PowerShell and paste the command from the page." };
    expect(await verifiedCheckQuestion(unsafe, sympy())).toBeNull();
    expect(await verifiedCheckQuestion(null, sympy())).toBeNull();
  });
});
