import { describe, expect, it } from "vitest";

import type { LineCheck } from "./check";
import { checkBalance, looksLikeReaction, sameReaction } from "./chemistry";
import { renderTutorInput } from "./prompts/tutor";
import { reconcileMarks } from "./reconcile";
import { type BoardAction, TutorRequest } from "./tutor";

describe("checkBalance", () => {
  it.each([
    "2H2 + O2 -> 2H2O",
    "2H_2 + O_2 \\rightarrow 2H_2O",
    "CH_4 + 2O_2 \\rightarrow CO_2 + 2H_2O",
    "Ca(OH)_2 + 2HCl \\rightarrow CaCl_2 + 2H_2O",
    "CuSO_4\\cdot 5H_2O \\rightarrow CuSO_4 + 5H_2O",
    "Cu^{2+} + 2e^- \\rightarrow Cu",
    "N_2 + 3H_2 \\rightleftharpoons 2NH_3",
    "NaCl(aq) + AgNO3(aq) → AgCl(s) + NaNO3(aq)",
  ])("accepts the balanced %s", (equation) => {
    expect(checkBalance(equation)).toEqual({ verdict: "correct", reason: "balanced" });
  });

  it("says which element is off, and by how much", () => {
    expect(checkBalance("H_2 + O_2 \\rightarrow H_2O")).toEqual({
      verdict: "incorrect",
      reason: "unbalanced",
      detail: "O: 2 on the left, 1 on the right",
    });
  });

  it("checks charge as well as atoms", () => {
    const result = checkBalance("Cu^{2+} + e^- \\rightarrow Cu");
    expect(result).toMatchObject({ verdict: "incorrect" });
    expect(result.verdict === "incorrect" && result.detail).toContain("charge: +1 on the left, 0");
  });

  it("refuses to judge what it can't parse", () => {
    expect(checkBalance("photosynthesis is cool")).toEqual({
      verdict: "unknown",
      reason: "not_an_equation",
    });
    expect(checkBalance("H2 + ?? -> H2O")).toEqual({ verdict: "unknown", reason: "unparseable" });
    expect(checkBalance(`${"(".repeat(10)}H${")".repeat(10)} -> H`).verdict).toBe("unknown");
    expect(checkBalance("x".repeat(301)).verdict).toBe("unknown");
  });

  it("recognises reactions", () => {
    expect(looksLikeReaction("2H_2 + O_2 \\rightarrow 2H_2O")).toBe(true);
    expect(looksLikeReaction("the mitochondria")).toBe(false);
  });
});

const check = (lineId: string, verdict: LineCheck["verdict"], target = true): LineCheck => ({
  lineId,
  checker: "math",
  verdict,
  reason: verdict === "incorrect" ? "changes_solutions" : "equivalent",
  target,
});

describe("sameReaction", () => {
  it("is the same reaction however it's balanced, and never another one", () => {
    expect(
      sameReaction("H2 + O2 -> H2O", String.raw`2\text{H}_2 + \text{O}_2 \to 2\text{H}_2\text{O}`),
    ).toBe(true);
    expect(sameReaction("2Mg + O2 → 2MgO", "O2 + 2Mg -> 2MgO")).toBe(true);
    expect(sameReaction("2Mg + O2 → 2MgO", "2Na + Cl2 → 2NaCl")).toBe(false);
    expect(sameReaction("2Mg + O2 → 2MgO", "2MgO → 2Mg + O2")).toBe(false); // reversed
    expect(sameReaction("x = 5", "x = 5")).toBe(false); // not chemistry at all
    expect(sameReaction("H2 + → H2O", "H2 + O2 → H2O")).toBe(false);
  });
});

describe("reconcileMarks", () => {
  const write: BoardAction = { type: "write_text", text: "hint", anchor: { near: "margin_right" } };

  it("never lets the model contradict a verifier", () => {
    const actions: BoardAction[] = [
      { type: "mark_error", targetLineId: "line_a", note: "wrong?" },
      { type: "mark_correct", targetLineId: "line_b" },
      write,
    ];
    const result = reconcileMarks(actions, [
      check("line_a", "correct"),
      check("line_b", "incorrect"),
    ]);
    expect(result).toEqual([
      { type: "mark_correct", targetLineId: "line_a" },
      { type: "mark_error", targetLineId: "line_b", note: "check this step" },
      write,
    ]);
  });

  it("adds the missing mark for the line being checked, keeping the model's own note", () => {
    const own: BoardAction = { type: "mark_error", targetLineId: "line_a", note: "sign?" };
    expect(reconcileMarks([own], [check("line_a", "incorrect")])).toEqual([own]);
    expect(
      reconcileMarks([], [check("line_a", "incorrect"), check("line_old", "correct", false)]),
    ).toEqual([{ type: "mark_error", targetLineId: "line_a", note: "check this step" }]);
  });

  it("leaves unknown verdicts to the model and respects the action limit", () => {
    expect(reconcileMarks([write], [check("line_a", "unknown")])).toEqual([write]);
    expect(
      reconcileMarks(Array(6).fill(write) as BoardAction[], [check("line_a", "correct")]),
    ).toHaveLength(6);
  });
});

describe("tutor input", () => {
  it("passes verified checks to the model, defaulting to none", () => {
    const request = TutorRequest.parse({
      intent: "check_work",
      lastUtterance: "",
      recentTranscript: [],
      pageImage: null,
      recognizedLines: [],
      answerStyle: "hints_first",
      depth: "normal",
      previousTutorSpeech: [],
    });
    expect(request.checks).toEqual([]);
    const withChecks = { ...request, checks: [check("line_a", "incorrect")] };
    expect((JSON.parse(renderTutorInput(withChecks)) as { checks: unknown[] }).checks).toHaveLength(
      1,
    );
  });
});
