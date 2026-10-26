import { describe, expect, it } from "vitest";

import {
  clampNote,
  levelShows,
  liveEvidence,
  type LiveMarkInput,
  markHint,
  planLiveMark,
  signSlip,
  wrongPart,
} from "./annotations";

const input = (changes: Partial<LiveMarkInput> = {}): LiveMarkInput => ({
  check: { verdict: "incorrect", checker: "math", reason: "changes_solutions" },
  text: "3x = 26",
  confidence: 0.92,
  previousText: "3x + 7 = 19",
  checkable: true,
  level: "normal",
  existing: null,
  ...changes,
});

describe("the mark a finished line gets (K9 §7.1–7.2)", () => {
  it("circles a wrong line with a hint, never the fix", () => {
    expect(planLiveMark(input())).toEqual({
      remove: false,
      resolved: false,
      add: { kind: "error", note: "sign?" },
    });
  });

  it("ticks only what a verifier said is right", () => {
    const right = { verdict: "correct", checker: "math", reason: "equivalent" } as const;
    expect(planLiveMark(input({ check: right })).add).toEqual({ kind: "tick", note: null });
    const unknown = { verdict: "unknown", checker: null, reason: "first_line" } as const;
    expect(planLiveMark(input({ check: unknown })).add).toBeNull();
  });

  it("never marks a line wrong when it wasn't read with confidence: a ? instead", () => {
    const plan = planLiveMark(input({ confidence: 0.6 }));
    expect(plan.add).toEqual({ kind: "unsure", note: "?" });
    // Even with nothing decided, a doubtful reading of a maths line gets its "?".
    const unknown = { verdict: "unknown", checker: null, reason: "unparseable" } as const;
    expect(planLiveMark(input({ check: unknown, confidence: 0.5 })).add?.kind).toBe("unsure");
    expect(
      planLiveMark(input({ check: unknown, confidence: 0.5, checkable: false })).add,
    ).toBeNull();
  });

  it("resolves a fixed line's mark into a tick, and keeps one mark for the same mistake", () => {
    const right = { verdict: "correct", checker: "math", reason: "equivalent" } as const;
    const marked = { markKind: "error", recognizedText: "3x = 26" } as const;
    expect(planLiveMark(input({ check: right, text: "3x = 12", existing: marked }))).toEqual({
      remove: true,
      resolved: true,
      add: { kind: "tick", note: null },
    });
    expect(planLiveMark(input({ existing: marked, text: "3x=26" }))).toEqual({
      remove: false,
      resolved: false,
      add: null,
    });
    // A different mistake replaces the mark (still one).
    const other = planLiveMark(input({ existing: marked, text: "3x = 13" }));
    expect(other.remove).toBe(true);
    expect(other.add?.kind).toBe("error");
  });

  it("follows the level: Quiet shows errors only, Off nothing", () => {
    const right = { verdict: "correct", checker: "math", reason: "equivalent" } as const;
    expect(planLiveMark(input({ check: right, level: "quiet" })).add).toBeNull();
    expect(planLiveMark(input({ level: "quiet" })).add?.kind).toBe("error");
    expect(planLiveMark(input({ level: "off" })).add).toBeNull();
    expect(levelShows("normal", "margin")).toBe(false);
    expect(levelShows("coach", "margin")).toBe(true);
  });

  it("says what kind of problem it is", () => {
    expect(markHint({ checker: "math", reason: "units" }, "v = 5", null)).toEqual({
      kind: "missing",
      note: "units?",
    });
    expect(
      markHint({ checker: "chemistry", reason: "unbalanced" }, "H2 + O2 -> H2O", null),
    ).toEqual({ kind: "missing", note: "not balanced" });
    expect(markHint({ checker: "math", reason: "not_equal" }, "2 + 2 = 5", null).note).toBe(
      "check arithmetic",
    );
    expect(
      markHint({ checker: "math", reason: "changes_solutions" }, "3x = 13", "3x + 7 = 19"),
    ).toEqual({ kind: "error", note: "check this step" });
  });

  it("spots a sign slip, and not a sum of two numbers on the same side", () => {
    expect(signSlip("3x + 7 = 19", "3x = 26")).toBe(true);
    expect(signSlip("3x - 7 = 19", "3x = 12")).toBe(true);
    expect(signSlip("2x + 3 = 7", "2x = 5")).toBe(false);
    expect(signSlip("2x + 3", "2x = 5")).toBe(false);
  });

  it("finds the wrong side of an equation to circle", () => {
    expect(wrongPart("3x + 7 = 19", "3x = 26")).toEqual({ from: 4 / 7, to: 1 });
    expect(wrongPart("3x + 7 = 19", "4x = 19")).toEqual({ from: 0, to: 3 / 7 });
    expect(wrongPart(null, "3x = 26")).toBeNull();
    expect(wrongPart("3x + 7", "3x = 26")).toBeNull();
  });

  it("counts a line by how it got right", () => {
    expect(liveEvidence({ hadMark: false, whyAsked: false })).toBe("independent");
    expect(liveEvidence({ hadMark: true, whyAsked: false })).toBe("with_hint");
    expect(liveEvidence({ hadMark: true, whyAsked: true })).toBe("after_explanation");
  });

  it("keeps a margin note to four words", () => {
    expect(clampNote("  evidence for this claim please  ")).toBe("evidence for this claim");
    expect(clampNote("\u0007 ")).toBeNull();
  });
});
