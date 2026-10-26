import { describe, expect, it } from "vitest";

import { SavedSolution } from "./saved-solution";
import {
  asksForAnswer,
  bringsInVariables,
  numbersChain,
  variablesOf,
  withoutUnits,
  clipWhy,
  inAnswerForm,
  showsAsWords,
  solutionChain,
  solvedFor,
  toSavedSolution,
  type VerifiedSolution,
} from "./solution";

describe("solvedFor", () => {
  it.each([
    ["x = 5", "x"],
    ["x=5", "x"],
    ["y = -\\frac{3}{2}", "y"],
    ["x_1 = 4", "x_1"],
    ["x_{1} = 4", "x_1"],
    ["t = 2.5\\text{ s}", "t"],
    ["x = 2y", "x"],
    ["x = x_1 + 2", "x"],
  ])("%s is solved for %s", (latex, variable) => {
    expect(solvedFor(latex)).toBe(variable);
  });

  it.each([
    ["5x = 25"],
    ["x = 2x - 5"],
    ["x + 1 = 6"],
    ["12"],
    ["x = "],
    ["x == 5"],
    ["x_1 = x_1"],
  ])("%s isn't solved for a variable", (latex) => {
    expect(solvedFor(latex)).toBeNull();
  });
});

describe("inAnswerForm", () => {
  it("needs the line solved for the key's variable (a step on the way isn't the answer)", () => {
    expect(inAnswerForm("x = 5", "x = 5")).toBe(true);
    expect(inAnswerForm("x = \\frac{10}{2}", "x = 5")).toBe(true);
    expect(inAnswerForm("5x = 25", "x = 5")).toBe(false); // equivalent, but not done
    expect(inAnswerForm("y = 5", "x = 5")).toBe(false);
  });

  it("takes an expression for an expression's key", () => {
    expect(inAnswerForm("12", "12")).toBe(true);
    expect(inAnswerForm("3 \\cdot 4", "12")).toBe(true);
    expect(inAnswerForm("x = 12", "12")).toBe(false);
  });

  it("never finishes against a key that isn't a final answer", () => {
    expect(inAnswerForm("5x = 25", "5x = 25")).toBe(false);
  });
});

describe("clipWhy", () => {
  it("keeps a reason to 20 words, cut at a word", () => {
    const long = Array.from({ length: 25 }, (_, i) => `word${i}`).join(" ");
    const clipped = clipWhy(`${long}.`);
    expect(clipped.split(" ")).toHaveLength(20);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipWhy("Subtract 7 from both sides,  to undo the plus 7.")).toBe(
      "Subtract 7 from both sides, to undo the plus 7.",
    );
  });
});

describe("solutionChain", () => {
  it("lists the problem, the steps with LaTeX and the answer, and where each came from", () => {
    const chain = solutionChain({
      problem: { text: "3x + 7 = 19", latex: "3x + 7 = 19" },
      steps: [
        { work: "Subtract 7", latex: "3x = 12", why: "To undo the plus 7.", figure: null },
        { work: "Now divide", latex: null, why: "To get x alone.", figure: null },
      ],
      finalAnswer: { text: "x = 4", latex: "x = 4" },
    });
    expect(chain).toEqual({ lines: ["3x + 7 = 19", "3x = 12", "x = 4"], positions: [-1, 0, 2] });
  });
});

describe("asksForAnswer", () => {
  it.each([
    "just give me the answer",
    "Just tell me the answer",
    "just tell me the answer.",
    "What's the answer to number 3?",
    "what is the final answer",
    "solve it",
    "Solve this for me please",
    "can you just solve this",
    "show me the full solution",
    "Give me the solution!",
    "just answer it",
  ])("%s asks for the answer", (question) => {
    expect(asksForAnswer(question)).toBe(true);
  });

  it.each([
    "how do I solve this?",
    "why is this the hypotenuse?",
    "can you give me a hint",
    "explain this",
    "is my answer right?",
    "what does the answer mean here",
    "solve for x how?",
  ])("%s doesn't", (question) => {
    expect(asksForAnswer(question)).toBe(false);
  });
});

describe("toSavedSolution", () => {
  const solution: VerifiedSolution = {
    problem: { text: "3x + 7 = 19", latex: "3x + 7 = 19" },
    subject: "math",
    steps: [{ work: "3x = 12", latex: "3x = 12", why: "Subtract 7.", figure: null }],
    finalAnswer: { text: "x = 4", latex: "x = 4" },
    yourTurn: {
      problem: "5x − 4 = 21",
      latex: "5x - 4 = 21",
      answerKey: { text: "x = 5", latex: "x = 5" },
      skill: "two-step equations",
      conceptIds: ["c1"],
    },
    verification: { method: "sympy", passed: true },
    yourTurnVerified: true,
  };

  it("keeps what the notebook writes, and a Your Turn only when it was verified", () => {
    const saved = toSavedSolution(solution);
    expect(SavedSolution.parse(saved)).toEqual(saved);
    expect(saved.steps).toEqual([{ work: "3x = 12", latex: "3x = 12", why: "Subtract 7." }]);
    expect(saved.yourTurn?.answerKey.latex).toBe("x = 5");
    expect(toSavedSolution({ ...solution, yourTurnVerified: false }).yourTurn).toBeNull();
  });
});

describe("showsAsWords", () => {
  it("tells a word problem from an equation", () => {
    expect(showsAsWords("Solve 5x − 4 = 21")).toBe(false);
    expect(showsAsWords("5x - 4 = 21")).toBe(false);
    expect(showsAsWords("Find x when 3x + 2 = 11")).toBe(false);
    expect(
      showsAsWords("A bike accelerates from rest at 3 m/s² for 4 s. How far does it go?"),
    ).toBe(true);
    expect(showsAsWords("Balance the equation: N2 + H2 → NH3")).toBe(false);
  });
});

describe("physics on its numbers (K7)", () => {
  const tex = String.raw;

  it("leaves units out, and names a line's variables", () => {
    expect(withoutUnits(tex`s = 25 \text{ m}`)).toBe("s = 25");
    expect(withoutUnits(tex`v = 3\,\mathrm{m/s}`)).toBe("v = 3");
    expect(withoutUnits(tex`\theta = 30^\circ`)).toBe(tex`\theta = 30`);
    expect(variablesOf(tex`s = v_0 t + \frac{1}{2} a t^2`)).toEqual(["s", "v_0", "t", "a"]);
    expect(variablesOf(tex`s = 24 \text{ m}`)).toEqual(["s"]);
    expect(solvedFor(tex`s = 3 \text{ s}`)).toBe("s"); // the unit isn't the variable
  });

  it("knows a formula from a step", () => {
    const substituted = tex`s = \frac{1}{2} \cdot 3 \cdot 4^2`;
    expect(bringsInVariables(tex`s = \frac{1}{2} a t^2`, [substituted])).toBe(true);
    expect(bringsInVariables("s = 24", [substituted])).toBe(false);
    expect(bringsInVariables("5x = 25", ["5x - 4 = 21"])).toBe(false);
  });

  it("checks from the formula with its numbers put in, without units", () => {
    const step = (latex: string) => ({ work: latex, latex, why: "Because.", figure: null });
    const substituted = tex`s = 0 \cdot 5 + \frac{1}{2} \cdot 2 \cdot 5^2`;
    const chain = numbersChain({
      problem: { text: "A car accelerates from rest at 2 m/s² for 5 s. How far?", latex: null },
      steps: [step(tex`s = ut + \frac{1}{2}at^2`), step(substituted), step("s = 25")],
      finalAnswer: { text: "25 m", latex: tex`s = 25 \text{ m}` },
    });
    expect(chain).toEqual({ lines: [substituted, "s = 25", "s = 25"], positions: [1, 2, 3] });
    // Nothing with numbers put in before the answer: nothing to check from.
    expect(
      numbersChain({
        problem: { text: "How far?", latex: null },
        steps: [step(tex`s = ut + \frac{1}{2}at^2`)],
        finalAnswer: { text: "25 m", latex: tex`s = 25 \text{ m}` },
      }),
    ).toBeNull();
  });
});
