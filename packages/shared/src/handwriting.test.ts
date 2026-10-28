import { describe, expect, it } from "vitest";

import { TUTOR_LIMITS } from "./tutor";

import {
  balanced,
  characterErrorRate,
  chooseReading,
  confusionNote,
  confusionsOf,
  EMPTY_CONTEXT,
  HANDWRITING_LIMITS,
  HandwritingSampleInput,
  type HandwritingSampleSource,
  pickExamples,
  type RecognitionReadings,
  RecognizeLineRequest,
  sameFormula,
  sameLatex,
  substitutions,
  swapped,
  toRecognition,
  validChemistry,
  wordErrorRate,
} from "./handwriting";

const reading = (text: string, confidence: number, latex: string | null = text) => ({
  text,
  latex,
  confidence,
});
const math = (...readings: ReturnType<typeof reading>[]): RecognitionReadings => ({
  readings,
  subject: "math",
});

/** SymPy stand-in: a step is correct when it's in `correct` (keyed "previous → line"). */
function fakeSympy(correct: string[], unparseable: string[] = []) {
  const calls: string[][] = [];
  return {
    calls,
    checkMath: (steps: string[]) => {
      calls.push(steps);
      return Promise.resolve(
        steps.map((line, index) => {
          if (unparseable.includes(line))
            return { index, verdict: "unknown", reason: "unparseable" };
          const key = `${steps[index - 1] ?? ""} → ${line}`;
          return {
            index,
            verdict: correct.includes(key) ? "correct" : index === 0 ? "unknown" : "incorrect",
            reason: "checked",
          };
        }),
      );
    },
  };
}

describe("chooseReading", () => {
  const context = { ...EMPTY_CONTEXT, previous: ["3x + 7 = 19"], subject: "math" as const };

  it("prefers the reading that's a correct step (the 1 vs 7 case)", async () => {
    const sympy = fakeSympy(["3x + 7 = 19 → 3x = 12"]);
    const chosen = await chooseReading(
      math(reading("3x = 1Z", 0.62), reading("3x = 12", 0.58)),
      context,
      sympy,
    );
    expect(chosen.reading.text).toBe("3x = 12");
    expect(chosen.chosenBy).toBe("math");
    // Each reading checked after the line above.
    expect(sympy.calls).toEqual([
      ["3x + 7 = 19", "3x = 1Z"],
      ["3x + 7 = 19", "3x = 12"],
    ]);
  });

  it("keeps a real mistake when no close reading fixes it", async () => {
    const sympy = fakeSympy([]);
    const chosen = await chooseReading(
      math(reading("3x = 26", 0.9), reading("3x = 2b", 0.4)),
      context,
      sympy,
    );
    expect(chosen.reading.text).toBe("3x = 26");
    expect(chosen.chosenBy).toBe("model");
  });

  it("never reaches for a reading far below the first", async () => {
    const sympy = fakeSympy(["3x + 7 = 19 → 3x = 12"]);
    const chosen = await chooseReading(
      math(reading("3x = 26", 0.95), reading("3x = 12", 0.3)),
      context,
      sympy,
    );
    expect(chosen.reading.text).toBe("3x = 26");
    expect(sympy.calls).toHaveLength(0);
  });

  it("keeps the first reading when it's already a correct step", async () => {
    const sympy = fakeSympy(["3x + 7 = 19 → 3x = 12", "3x + 7 = 19 → 3 × = 12"]);
    const chosen = await chooseReading(
      math(reading("3x = 12", 0.7), reading("3 × = 12", 0.6)),
      context,
      sympy,
    );
    expect(chosen.reading.text).toBe("3x = 12");
    expect(chosen.alternatives.map((a) => a.text)).toEqual(["3 × = 12"]);
  });

  it("prefers a reading SymPy can parse over one it can't", async () => {
    const sympy = fakeSympy([], ["x = 4)"]);
    const chosen = await chooseReading(
      math(reading("x = 4)", 0.6), reading("x = 4", 0.55)),
      context,
      sympy,
    );
    expect(chosen.reading.text).toBe("x = 4");
  });

  it("swaps the student's own look-alikes back when that makes the line correct", async () => {
    // Writer whose 7 reads as 1: "17 + 7 = 24" read "11 + 1 = 24" (false on its own).
    const sympy = fakeSympy([" → 17 + 7 = 24", " → 11 + 7 = 24"]);
    const chosen = await chooseReading(
      math(reading("11 + 1 = 24", 0.8)),
      { ...EMPTY_CONTEXT, subject: "math" },
      { ...sympy, confusions: [{ read: "1", meant: "7", count: 3 }] },
    );
    // Fewest swaps first: "71 + 1", "17 + 1", "11 + 7" (correct here) before "17 + 7".
    expect(chosen.reading.text).toBe("11 + 7 = 24");
    expect(chosen.chosenBy).toBe("profile");
    expect(chosen.alternatives.map((a) => a.text)).toEqual(["11 + 1 = 24"]);
  });

  it("never swaps without a profile, nor a line that's already correct", async () => {
    const sympy = fakeSympy([" → 21 - 1 = 20"]);
    const kept = await chooseReading(
      math(reading("21 - 1 = 20", 0.8)),
      { ...EMPTY_CONTEXT, subject: "math" },
      { ...sympy, confusions: [{ read: "1", meant: "7", count: 3 }] },
    );
    expect(kept.reading.text).toBe("21 - 1 = 20");
    const none = fakeSympy([" → 17 + 7 = 24"]);
    const plainChoice = await chooseReading(math(reading("11 + 1 = 24", 0.8)), EMPTY_CONTEXT, none);
    expect(plainChoice.reading.text).toBe("11 + 1 = 24");
    expect(none.calls).toHaveLength(0);
  });

  it("swaps only digits and signs, never letters (they're in LaTeX commands)", () => {
    const swaps = swapped({ text: "1/2", latex: "\\frac{1}{2}", confidence: 0.9 }, [
      { read: "1", meant: "7", count: 2 },
      { read: "a", meant: "o", count: 2 },
    ]);
    expect(swaps.map((s) => s.latex)).toEqual(["\\frac{7}{2}"]);
  });

  it("falls back to the model when SymPy is unreachable", async () => {
    const chosen = await chooseReading(math(reading("a", 0.6), reading("b", 0.55)), context, {
      checkMath: () => Promise.resolve(null),
    });
    expect(chosen.chosenBy).toBe("model");
    expect(chosen.reading.text).toBe("a");
  });

  it("chemistry: prefers a valid formula", async () => {
    const chosen = await chooseReading(
      { readings: [reading("C0_2", 0.6), reading("CO_2", 0.55)], subject: "chemistry" },
      EMPTY_CONTEXT,
    );
    expect(chosen.reading.text).toBe("CO_2");
    expect(chosen.chosenBy).toBe("chemistry");
  });

  it("code: prefers a line whose brackets balance", async () => {
    const chosen = await chooseReading(
      {
        readings: [reading("print(x]", 0.6, null), reading("print(x)", 0.5, null)],
        subject: "programming",
      },
      EMPTY_CONTEXT,
    );
    expect(chosen.reading.text).toBe("print(x)");
  });

  it("drops duplicate readings", async () => {
    const chosen = await chooseReading(math(reading("x", 0.9), reading("x", 0.8)), context);
    expect(chosen.alternatives).toEqual([]);
  });

  it("toRecognition: a blank reading is never sure", () => {
    const r = toRecognition(
      { reading: reading("", 0.9), alternatives: [], chosenBy: "model" },
      "math",
    );
    expect(r.confidence).toBe(0);
    expect(r).not.toHaveProperty("alternatives");
  });
});

describe("validChemistry and balanced", () => {
  it("knows elements and formulas", () => {
    expect(validChemistry("H_2O")).toBe(true);
    expect(validChemistry("CuSO_4")).toBe(true);
    expect(validChemistry("Xz_2")).toBe(false);
    expect(validChemistry("C0_2")).toBe(false);
    expect(validChemistry("2H_2 + O_2 \\rightarrow 2H_2O")).toBe(true);
  });

  it("checks brackets and quotes", () => {
    expect(balanced('print("a)")')).toBe(true);
    expect(balanced("f(x]")).toBe(false);
    expect(balanced("'open")).toBe(false);
  });
});

describe("the profile", () => {
  const sample = (
    text: string,
    readAs: string | null,
    source: HandwritingSampleSource = "fix",
    createdAt = 0,
  ) => ({
    text,
    readAs,
    source,
    createdAt,
  });

  it("finds the look-alikes in corrections", () => {
    const c = confusionsOf([sample("x = 7", "x = 1"), sample("7 + 2", "1 + 2"), sample("z", "2")]);
    expect(c[0]).toEqual({ read: "1", meant: "7", count: 2 });
    expect(c).toContainEqual({ read: "2", meant: "z", count: 1 });
  });

  it("writes a note only for confusions seen enough", () => {
    const c = confusionsOf([sample("7", "1"), sample("77", "11"), sample("z", "2")]);
    const note = confusionNote(c);
    expect(note).toContain(`This student's "7" can look like "1"`);
    expect(note).toContain(`their own "7" and "1"`);
    expect(note).not.toContain(`"z"`);
    expect(confusionNote([])).toBeNull();
  });

  it("picks the student's own look-alike shapes, then corrections showing them, each once", () => {
    const samples = [
      sample("hello", null, "confirm", 9),
      sample("7", null, "calibration", 1),
      sample("x = 7", "x = 1", "fix", 2),
      sample("x = 7", "x = 1", "fix", 3),
      sample("abc", "abd", "fix", 4),
    ];
    const picked = pickExamples(samples, 3);
    // Their own calibration "7" first (to compare shapes), then the corrections showing it.
    expect(picked.map((s) => s.text)).toEqual(["7", "x = 7", "abc"]);
  });

  it("validates samples: a real PNG and no control characters", () => {
    const base = {
      id: "6a1f4d1e-8b0c-4c58-9d1b-2f0b8a4b6f11",
      text: "7",
      latex: "7",
      readAs: "1",
      source: "fix",
      image: "iVBORw0KGgoAAAANSUhEUg==",
    };
    expect(HandwritingSampleInput.safeParse(base).success).toBe(true);
    expect(HandwritingSampleInput.safeParse({ ...base, image: "PHN2Zz4=" }).success).toBe(false);
    expect(HandwritingSampleInput.safeParse({ ...base, text: "a\u0007" }).success).toBe(false);
    expect(HandwritingSampleInput.safeParse({ ...base, text: "  " }).success).toBe(false);
  });

  it("takes the same picture size as any recognition request", () => {
    expect(HANDWRITING_LIMITS.requestImageChars).toBe(TUTOR_LIMITS.imageBase64Chars);
  });

  it("takes a context with a recognition request", () => {
    const ok = RecognizeLineRequest.safeParse({ image: "x", context: EMPTY_CONTEXT });
    expect(ok.success).toBe(true);
    const tooMany = RecognizeLineRequest.safeParse({
      image: "x",
      context: { ...EMPTY_CONTEXT, previous: ["a", "b", "c"] },
    });
    expect(tooMany.success).toBe(false);
  });
});

describe("metrics", () => {
  it("character and word error rates", () => {
    expect(characterErrorRate("3x = 12", "3x = 12")).toBe(0);
    expect(characterErrorRate("3x = 12", "3x = 17")).toBeCloseTo(1 / 7);
    expect(characterErrorRate("a  b", "a b")).toBe(0);
    expect(wordErrorRate("the cat sat", "the hat sat")).toBeCloseTo(1 / 3);
  });

  it("substitutions are aligned pairs", () => {
    expect(substitutions("3x=17", "3x=12")).toEqual([["7", "2"]]);
    expect(substitutions("ab", "abc")).toEqual([]);
  });

  it("compares LaTeX and formulas loosely", () => {
    expect(sameLatex("x^{2} + 1", "x^2+1")).toBe(true);
    expect(sameLatex("\\left(x\\right)", "(x)")).toBe(true);
    expect(sameLatex("x^2", "x^3")).toBe(false);
    expect(sameFormula("H_{2}O", "H2O")).toBe(true);
  });
});
