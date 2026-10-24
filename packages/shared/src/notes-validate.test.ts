import { describe, expect, it } from "vitest";

import type { ModelFinding, NotesCompareOutput } from "./notes-check";
import {
  type CheckedFinding,
  sameNotableFindings,
  summarySpeech,
  usableSpeech,
  validateFindings,
  type ValidationInput,
} from "./notes-validate";

const INPUT: ValidationInput = {
  blocks: [
    { blockId: "b1", text: "Enzymes are biological catalysts." },
    { blockId: "b2", text: "Enzymes are  NOT consumed by the reaction." },
    { blockId: "b3", text: "Activation energy is the minimum energy needed for a reaction." },
  ],
  lines: [
    { id: "L1", text: "Enzymes = biological catalysts", confidence: 0.92, source: "ink" },
    { id: "L2", text: "enzymes are used up in the reaction", confidence: 0.9, source: "ink" },
    { id: "L3", text: "enzymes are uscd up", confidence: 0.41, source: "ink" },
    { id: "L4", text: "Enzymes are consumed by the reaction", confidence: 1, source: "clip" },
  ],
};

const difference: ModelFinding = {
  type: "difference",
  lineIds: ["L2"],
  blockIds: ["b2"],
  noteQuote: "enzymes are used up",
  screenQuote: "Enzymes are not consumed by the reaction",
  explanation: "Consumed vs not consumed.",
  question: "Your notes say enzymes get used up. What does the slide say happens to them?",
  confidence: 0.9,
};

function run(...findings: ModelFinding[]) {
  const output: NotesCompareOutput = { topic: "Enzymes", speech: "", findings };
  return validateFindings(output, INPUT);
}

describe("validateFindings", () => {
  it("keeps a well-grounded difference", () => {
    const { findings, dropped } = run(difference);
    expect(dropped).toEqual({});
    expect(findings).toEqual([
      expect.objectContaining({ type: "difference", lineIds: ["L2"], evidence: ["model"] }),
    ]);
  });

  it("matches quotes ignoring only case and whitespace", () => {
    expect(run({ ...difference, screenQuote: "enzymes are not   consumed" }).findings).toHaveLength(
      1,
    );
    // Different words are not the same quote, however close.
    expect(run({ ...difference, screenQuote: "Enzymes aren't consumed" }).dropped).toEqual({
      quote_not_found: 1,
    });
    expect(run({ ...difference, noteQuote: "enzymes get used up" }).dropped).toEqual({
      quote_not_found: 1,
    });
  });

  it("accepts a quote shortened with an ellipsis, only if every piece is there in order", () => {
    expect(
      run({ ...difference, screenQuote: "Enzymes are... consumed by the reaction" }).findings,
    ).toHaveLength(1);
    expect(run({ ...difference, screenQuote: "the reaction … Enzymes are" }).dropped).toEqual({
      quote_not_found: 1,
    });
    expect(run({ ...difference, screenQuote: "..." }).dropped).toEqual({ quote_not_found: 1 });
  });

  it("drops findings naming ids that weren't given", () => {
    expect(run({ ...difference, lineIds: ["L9"] }).dropped).toEqual({ unknown_ids: 1 });
    expect(run({ ...difference, blockIds: ["b9"] }).dropped).toEqual({ unknown_ids: 1 });
    expect(run({ ...difference, blockIds: [] }).dropped).toEqual({ unknown_ids: 1 });
  });

  it("drops a difference the model isn't confident about", () => {
    expect(run({ ...difference, confidence: 0.7 }).dropped).toEqual({ low_confidence: 1 });
  });

  it("turns a difference on hard-to-read handwriting into a question about it", () => {
    const { findings, downgraded } = run({
      ...difference,
      lineIds: ["L3"],
      noteQuote: "enzymes are uscd up",
      confidence: 0.95,
    });
    expect(downgraded).toBe(1);
    expect(findings.map((f) => f.type)).toEqual(["unclear"]);
  });

  it("never makes a saved clip's text the student's mistake", () => {
    const onClip = { ...difference, lineIds: ["L4"], noteQuote: "Enzymes are consumed" };
    expect(run(onClip).dropped).toEqual({ clip_line: 1 });
    const mixed = run({ ...difference, lineIds: ["L2", "L4"] });
    expect(mixed.findings[0]?.lineIds).toEqual(["L2"]);
  });

  it("needs a quote from the notes and a question for anything but a match", () => {
    expect(run({ ...difference, noteQuote: " " }).dropped).toEqual({ missing_quote: 1 });
    expect(run({ ...difference, question: "" }).dropped).toEqual({ missing_question: 1 });
    expect(run({ ...difference, question: Array(40).fill("word").join(" ") }).dropped).toEqual({
      missing_question: 1,
    });
  });

  it("drops questions that accuse or are unsafe, and softens exclamations", () => {
    expect(run({ ...difference, question: "This line is wrong. Can you fix it?" }).dropped).toEqual(
      { tone: 1 },
    );
    expect(run({ ...difference, question: "Made a mistake here?" }).dropped).toEqual({ tone: 1 });
    expect(run({ ...difference, question: "Open PowerShell and check?" }).dropped).toEqual({
      unsafe: 1,
    });
    expect(
      run({ ...difference, question: "Look again at the slide! What does it say?" }).findings[0]
        ?.question,
    ).toBe("Look again at the slide. What does it say?");
  });

  it("keeps gaps lineless, checks where they'd go, and drops gaps on covered blocks", () => {
    const gap: ModelFinding = {
      type: "gap",
      lineIds: ["L1"],
      blockIds: ["b3"],
      noteQuote: "",
      screenQuote: "Activation energy is the minimum energy",
      explanation: "Not in notes.",
      question: "The slide defines activation energy. Want to add it in your own words?",
      suggestedInsertAfterLineId: "L9",
      confidence: 0.8,
    };
    const [kept] = run(gap).findings;
    expect(kept?.lineIds).toEqual([]);
    expect(kept?.insertAfter).toBeUndefined();
    expect(run({ ...gap, suggestedInsertAfterLineId: "L1" }).findings[0]?.insertAfter).toBe("L1");

    const match: ModelFinding = {
      ...difference,
      type: "match",
      lineIds: ["L1"],
      blockIds: ["b1"],
      noteQuote: "biological catalysts",
      screenQuote: "biological catalysts",
    };
    expect(
      run(match, { ...gap, blockIds: ["b1"], screenQuote: "Enzymes are biological" }).dropped,
    ).toEqual({ inconsistent: 1 });
  });

  it("never reports a heading on its own as a gap, but keeps short formulas", () => {
    const blocks = [
      ...INPUT.blocks,
      { blockId: "b4", text: "Mountains" },
      { blockId: "b5", text: "Time complexity: O(log n)" },
    ];
    const gap = (blockId: string, screenQuote: string): ModelFinding => ({
      type: "gap",
      lineIds: [],
      blockIds: [blockId],
      noteQuote: "",
      screenQuote,
      explanation: "",
      question: "Want to add it in your own words?",
      confidence: 0.8,
    });
    const output = {
      topic: "",
      speech: "",
      findings: [gap("b4", "Mountains"), gap("b5", "O(log n)")],
    };
    const { findings, dropped } = validateFindings(output, { ...INPUT, blocks });
    expect(dropped).toEqual({ heading_gap: 1 });
    expect(findings.map((f) => f.screenQuote)).toEqual(["O(log n)"]);
  });

  it("never lets a match carry a question, and keeps one of each duplicate", () => {
    const match: ModelFinding = {
      ...difference,
      type: "match",
      lineIds: ["L1"],
      blockIds: ["b1"],
      noteQuote: "biological catalysts",
      screenQuote: "biological catalysts",
    };
    const { findings, dropped } = run(match, { ...match, confidence: 0.99 });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.question).toBeUndefined();
    expect(findings[0]?.confidence).toBe(0.99);
    expect(dropped).toEqual({ duplicate: 1 });
  });

  it("enforces the caps, keeping the most confident", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      ...difference,
      blockIds: ["b2"],
      lineIds: ["L2"],
      confidence: 0.8 + i / 100,
      screenQuote: "Enzymes are not consumed",
      noteQuote: i % 2 ? "enzymes are used up" : "used up in the reaction",
    }));
    // Distinct quotes don't make distinct findings: same type, lines and blocks is a duplicate.
    expect(run(...many).findings).toHaveLength(1);
  });
});

describe("speech", () => {
  const finding = (type: CheckedFinding["type"], conceptHint?: string): CheckedFinding => ({
    type,
    lineIds: type === "gap" ? [] : ["L1"],
    blockIds: ["b1"],
    screenQuote: "x",
    explanation: "",
    sourceConflict: false,
    confidence: 0.9,
    evidence: ["model"],
    ...(conceptHint && { conceptHint }),
  });

  it("uses the model's summary only when it's safe, gentle and short", () => {
    expect(usableSpeech("Most of this matches your notes! One line to look at again.")).toBe(
      "Most of this matches your notes. One line to look at again.",
    );
    expect(usableSpeech("Your notes are wrong.")).toBeNull();
    expect(usableSpeech("One. Two. Three.")).toBeNull();
    expect(usableSpeech("Run this command in PowerShell.")).toBeNull();
  });

  it("knows when validation changed what the summary talks about", () => {
    const before = [
      { type: "difference" as const, lineIds: ["L2"], blockIds: ["b2"] },
      { type: "match" as const, lineIds: ["L1"], blockIds: ["b1"] },
    ];
    expect(
      sameNotableFindings(
        before,
        [finding("difference")].map((f) => ({ ...f, lineIds: ["L2"], blockIds: ["b2"] })),
      ),
    ).toBe(true);
    expect(sameNotableFindings(before, [finding("match")])).toBe(false);
  });

  it("builds a short summary from the findings", () => {
    expect(
      summarySpeech([finding("match"), finding("difference"), finding("gap", "Activation energy")]),
    ).toBe(
      "Most of this matches your notes. There's one line I'd like you to look at again, and the screen covers activation energy that your notes don't have yet.",
    );
    expect(summarySpeech([finding("match")])).toBe("This matches your notes. You've got it.");
    expect(summarySpeech([finding("unclear")])).toBe(
      "I couldn't quite read one of your lines, so let's check it together.",
    );
  });
});
