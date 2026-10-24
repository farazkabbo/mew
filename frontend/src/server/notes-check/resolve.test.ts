import { NOTES_RESOLVE_PROMPT, type StoredFinding } from "@mew/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GenerateStructured } from "../gemini";
import {
  dismissFinding,
  explainFinding,
  gapHeading,
  headingOf,
  type ResolveDeps,
  resolveFinding,
} from "./resolve";

vi.stubEnv("GEMINI_API_KEY", "test-key");

const COURSE = "11111111-1111-4111-8111-111111111111";
const CONCEPT = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";

const DIFFERENCE: StoredFinding = {
  id: ID,
  checkId: "44444444-4444-4444-8444-444444444444",
  type: "difference",
  noteLineIds: ["55555555-5555-4555-8555-555555555555"],
  pageId: "66666666-6666-4666-8666-666666666666",
  noteQuote: "used up",
  screenSnippet: "Enzymes are not consumed",
  question: "What does the slide say happens to enzymes?",
  explanation: "Consumed vs not consumed.",
  conceptHint: "Enzymes as catalysts",
  conceptId: null,
  confidence: 0.9,
  sourceConflict: false,
  status: "open",
  courseId: COURSE,
};

let updates: { id: string; status: string; conceptId?: string | undefined }[];
let recorded: unknown[];

function deps(answer: unknown, finding: StoredFinding = DIFFERENCE): ResolveDeps {
  return {
    generate: (async () => answer) as GenerateStructured,
    finding: async () => finding,
    update: async (id, status, conceptId) => {
      updates.push({ id, status, conceptId });
    },
    concepts: async () => [
      { id: CONCEPT, title: "Enzymes and catalysts" },
      { id: "77777777-7777-4777-8777-777777777777", title: "Diffusion" },
    ],
    passage: async () => ({ page: 41, heading: null, text: "Enzymes are not used up." }),
    record: vi.fn(async (_course, attempt) => {
      recorded.push(attempt);
      return {} as never;
    }),
  };
}

beforeEach(() => {
  updates = [];
  recorded = [];
});

describe("resolveFinding", () => {
  it("a fixed line resolves the finding and counts as learning with a hint", async () => {
    const result = await resolveFinding(
      ID,
      { lineText: "enzymes are not used up" },
      deps({ outcome: "fixed", reply: "That matches the slide now. Nice work." }),
    );
    expect(result).toEqual({
      outcome: "fixed",
      reply: "That matches the slide now. Nice work.",
      status: "resolved_fixed",
    });
    expect(recorded).toEqual([
      { conceptId: CONCEPT, correct: true, evidence: "with_hint", source: "notes_check" },
    ]);
    expect(updates).toEqual([{ id: ID, status: "resolved_fixed", conceptId: CONCEPT }]);
  });

  it("concedes when the student's note was right, and records nothing against them", async () => {
    const result = await resolveFinding(
      ID,
      { reply: "The slide has a typo, my textbook says the same as my notes" },
      deps({ outcome: "student_right", reply: "You're right, your note was correct." }),
    );
    expect(result.status).toBe("resolved_student_right");
    expect(result.reply).toBe("You're right, your note was correct.");
    expect(recorded).toEqual([]);
    expect(updates).toEqual([{ id: ID, status: "resolved_student_right", conceptId: undefined }]);
  });

  it("keeps the finding open while the line still differs, without recording anything", async () => {
    const result = await resolveFinding(
      ID,
      { reply: "I think they get used up" },
      deps({ outcome: "still_different", reply: "Have another look at the slide's second line." }),
    );
    expect(result.status).toBe("open");
    expect(updates).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("a gap filled in the student's own words counts as independent", async () => {
    await resolveFinding(
      ID,
      { lineText: "activation energy = min energy to start" },
      deps({ outcome: "fixed", reply: "Great." }, { ...DIFFERENCE, type: "gap", noteQuote: null }),
    );
    expect(recorded).toEqual([expect.objectContaining({ correct: true, evidence: "independent" })]);
  });

  it("records nothing on a concept when the notes weren't for a course", async () => {
    await resolveFinding(
      ID,
      { reply: "fixed it" },
      deps({ outcome: "fixed", reply: "Good." }, { ...DIFFERENCE, courseId: null }),
    );
    expect(recorded).toEqual([]);
    expect(updates).toEqual([{ id: ID, status: "resolved_fixed", conceptId: undefined }]);
  });

  it("never says what the safety and tone rules forbid", async () => {
    const result = await resolveFinding(
      ID,
      { reply: "?" },
      deps({ outcome: "still_different", reply: "That's wrong. Open PowerShell and check." }),
    );
    expect(result.reply).toBe(
      "Have another look at what the material says, and compare it with your line.",
    );
  });

  it("refuses a finding that's already settled", async () => {
    await expect(
      resolveFinding(ID, { reply: "x" }, deps({}, { ...DIFFERENCE, status: "explained" })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("asks the model with the finding's quotes, never the whole notes", async () => {
    const generate = vi.fn(async () => ({
      outcome: "fixed",
      reply: "Good.",
    })) as unknown as GenerateStructured;
    await resolveFinding(ID, { lineText: "not used up" }, { ...deps({}), generate });
    const [request] =
      (generate as unknown as { mock: { calls: [{ system: string; input: string }][] } }).mock
        .calls[0] ?? [];
    expect(request?.system).toBe(NOTES_RESOLVE_PROMPT.system);
    expect(request?.input).toContain('LINE_NOW: "not used up"');
  });
});

describe("explainFinding", () => {
  it("explains from the material and counts as needing an explanation", async () => {
    const result = await explainFinding(
      ID,
      deps({ explanation: "The slide says enzymes are not consumed (p. 41)." }),
    );
    expect(result).toEqual({
      explanation: "The slide says enzymes are not consumed (p. 41).",
      status: "explained",
    });
    expect(recorded).toEqual([
      { conceptId: CONCEPT, correct: false, evidence: "after_explanation", source: "notes_check" },
    ]);
    expect(updates).toEqual([{ id: ID, status: "explained", conceptId: CONCEPT }]);
  });
});

describe("dismissFinding and gapHeading", () => {
  it("dismissing records nothing about the student", async () => {
    await dismissFinding(ID, deps({}));
    expect(updates).toEqual([{ id: ID, status: "dismissed", conceptId: undefined }]);
    expect(recorded).toEqual([]);
  });

  it("a gap's heading names the idea and never fills it in", async () => {
    const gap = { ...DIFFERENCE, type: "gap" as const, noteQuote: null };
    expect(await gapHeading(ID, deps({ heading: "Activation energy — ?" }, gap))).toEqual({
      heading: "Activation energy — ?",
    });
    // A heading that writes the content isn't one: the concept's name is used instead.
    expect(
      await gapHeading(
        ID,
        deps(
          { heading: "Activation energy is the minimum energy needed to start a reaction" },
          gap,
        ),
      ),
    ).toEqual({ heading: "Enzymes as catalysts — ?" });
    await expect(gapHeading(ID, deps({ heading: "x — ?" }))).rejects.toMatchObject({ status: 409 });
  });

  it("checks headings: short, a question, safe", () => {
    expect(headingOf("Opportunity cost — ?")).toBe("Opportunity cost — ?");
    expect(headingOf("Opportunity cost")).toBeNull();
    expect(headingOf("one two three four five six seven — ?")).toBeNull();
    expect(headingOf("Install this app — ?")).toBeNull();
  });
});
