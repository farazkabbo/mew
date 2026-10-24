import { describe, expect, it } from "vitest";

import { MewInput, MewOutput } from "./mew";
import {
  detectWakePhrase,
  enforceMewRules,
  fallbackMew,
  isNewQuestion,
  prefilterMew,
  shouldRespond,
} from "./mew-policy";

function input(overrides: Partial<MewInput> = {}): MewInput {
  return MewInput.parse({
    trigger: "utterance",
    lastUtterance: "",
    recentTranscript: [],
    notebookSignals: { msSinceLastStroke: null, justErased: false, linesWrittenLast60s: 0 },
    tutorSpokeRecently: false,
    explicitSummon: false,
    ...overrides,
  });
}

describe("prefilterMew", () => {
  it.each(["", "   ", "hmm", "okay so", "Um, wait…", "yeah okay right"])(
    "ignores filler without a model call: %j",
    (lastUtterance) => {
      expect(prefilterMew(input({ lastUtterance }))?.label).toBe("ignore");
    },
  );

  it.each([
    "okay so I'm reading this",
    "why does the force cancel out?",
    "so is this right",
    "I'm stuck",
  ])("leaves real speech to the model: %j", (lastUtterance) => {
    expect(prefilterMew(input({ lastUtterance }))).toBeNull();
  });

  it("never short-circuits a summon or a pen pause", () => {
    expect(prefilterMew(input({ lastUtterance: "hmm", explicitSummon: true }))).toBeNull();
    expect(prefilterMew(input({ trigger: "pen_pause" }))).toBeNull();
  });
});

describe("detectWakePhrase", () => {
  it.each([
    ["Hey Neb, why is this negative?", "why is this negative?"],
    ["hey nab what's next", "what's next"],
    ["Hey Mew, why is this negative?", "why is this negative?"],
    ["hey mu what's next", "what's next"],
    ["OK mew. Is this right?", "Is this right?"],
    ["is this right, hey mew", "is this right,"],
  ])("detects %j", (text, request) => {
    expect(detectWakePhrase(text)).toEqual({ summoned: true, request });
  });

  it.each(["they knew it", "hey, new idea", "mew", "the cat said mew", "heymew", "neb", "heyneb"])(
    "does not fire on %j",
    (text) => {
      expect(detectWakePhrase(text).summoned).toBe(false);
    },
  );
});

describe("isNewQuestion", () => {
  it.each(["Why is it negative?", "what about the second one", "can you show me", "ok?"])(
    "recognises %j",
    (text) => {
      expect(isNewQuestion(text)).toBe(true);
    },
  );
  it.each(["thanks", "okay got it", "right, so then I divide"])("rejects %j", (text) => {
    expect(isNewQuestion(text)).toBe(false);
  });
});

describe("decision rules", () => {
  const out = (label: MewOutput["label"], confidence: number): MewOutput => ({
    label,
    confidence,
    reason: "",
  });

  it("acts only at or above the threshold, unless summoned", () => {
    expect(
      shouldRespond(out("answer_question", 0.69), { threshold: 0.7, explicitSummon: false }),
    ).toBe(false);
    expect(
      shouldRespond(out("answer_question", 0.7), { threshold: 0.7, explicitSummon: false }),
    ).toBe(true);
    expect(shouldRespond(out("give_hint", 0.2), { threshold: 0.7, explicitSummon: true })).toBe(
      true,
    );
  });

  it("never acts on ignore", () => {
    expect(shouldRespond(out("ignore", 1), { threshold: 0, explicitSummon: true })).toBe(false);
  });

  it("turns an ignored summon into a question", () => {
    const enforced = enforceMewRules(input({ explicitSummon: true }), out("ignore", 0.9));
    expect(enforced.label).toBe("answer_question");
    expect(enforceMewRules(input(), out("ignore", 0.9)).label).toBe("ignore");
  });

  it("falls back to silence, or to answering when summoned", () => {
    expect(fallbackMew(input()).label).toBe("ignore");
    expect(fallbackMew(input({ explicitSummon: true })).label).toBe("answer_question");
  });

  it("validates gate output", () => {
    expect(MewOutput.safeParse({ label: "shout", confidence: 2, reason: "x" }).success).toBe(false);
  });
});
