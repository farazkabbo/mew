import type { CompareInput, ModelFinding, NotesCompareOutput, NotesRetrieval } from "@mew/shared";
import { NO_RELATED_NOTES_SPEECH, NOTES_SECOND_OPINION_PROMPT } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

import type { GenerateStructured, StructuredRequest } from "../gemini";
import { type CompareDeps, compareNotes, type MathVerdict } from "./compare";
import { type RunDeps, runNotesCheck } from "./run";

const INPUT: CompareInput = {
  subject: null,
  screen: [
    { blockId: "b1", text: "Enzymes are not consumed by the reaction." },
    { blockId: "b2", text: "F = ma" },
  ],
  notes: [
    {
      id: "L1",
      page: 3,
      text: "enzymes are used up in the reaction",
      latex: null,
      confidence: 0.9,
      source: "ink",
    },
    {
      id: "L2",
      page: 3,
      text: "a = F/m",
      latex: "a = \\frac{F}{m}",
      confidence: 0.9,
      source: "ink",
    },
  ],
  course: [],
};

const usedUp: ModelFinding = {
  type: "difference",
  lineIds: ["L1"],
  blockIds: ["b1"],
  noteQuote: "enzymes are used up",
  screenQuote: "Enzymes are not consumed",
  explanation: "Consumed vs not.",
  question: "Your notes say enzymes get used up. What does the slide say?",
  conceptHint: "Enzymes",
  confidence: 0.9,
};

const newtonAsDifference: ModelFinding = {
  type: "difference",
  lineIds: ["L2"],
  blockIds: ["b2"],
  noteQuote: "a = F/m",
  screenQuote: "F = ma",
  explanation: "Different form.",
  question: "How does your equation compare with the one on the slide?",
  screenMath: "F = m a",
  confidence: 0.85,
};

/** A fake model: the comparison answers `output`; the second opinion answers `conflict`. */
function fakeModel(output: NotesCompareOutput, conflict: boolean | Error = true) {
  const calls: StructuredRequest<unknown>[] = [];
  const generate = (async (request: StructuredRequest<unknown>) => {
    calls.push(request);
    if (request.system === NOTES_SECOND_OPINION_PROMPT.system) {
      if (conflict instanceof Error) throw conflict;
      return { conflict, reason: "test" };
    }
    return output;
  }) as GenerateStructured;
  return { generate, calls };
}

function deps(
  generate: GenerateStructured,
  equivalence: (pairs: { note: string; screen: string }[]) => Promise<MathVerdict[]> = async (
    pairs,
  ) => pairs.map(() => "unknown"),
): CompareDeps {
  return {
    generate,
    equivalence,
    models: { compare: "compare-model", verifier: "verifier-model" },
  };
}

const output = (findings: ModelFinding[], speech = "One line to look at again.") => ({
  topic: "Enzymes and forces",
  speech,
  findings,
});

describe("compareNotes", () => {
  it("keeps a difference both models agree on, and its summary", async () => {
    const { generate, calls } = fakeModel(output([usedUp]));
    const result = await compareNotes(INPUT, deps(generate));
    expect(result.findings).toEqual([
      expect.objectContaining({ type: "difference", evidence: ["model", "second_opinion"] }),
    ]);
    expect(result.speech).toBe("One line to look at again.");
    // The second opinion saw only the quotes, never the whole screen or notes.
    const opinion = calls.find((c) => c.system === NOTES_SECOND_OPINION_PROMPT.system);
    expect(String(opinion?.input)).not.toContain("F = ma");
  });

  it("turns an equivalent equation into a match, and says so", async () => {
    const equivalence = vi.fn(async () => ["equivalent"] as MathVerdict[]);
    const { generate } = fakeModel(
      output([newtonAsDifference], "There's one line to look at again."),
    );
    const result = await compareNotes(INPUT, deps(generate, equivalence));
    expect(equivalence).toHaveBeenCalledWith([{ note: "a = \\frac{F}{m}", screen: "F = m a" }]);
    expect(result.findings).toEqual([
      expect.objectContaining({ type: "match", evidence: ["model", "sympy"] }),
    ]);
    expect(result.findings[0]?.question).toBeUndefined();
    // The model's summary talked about a difference that no longer exists: rebuilt.
    expect(result.speech).toBe("This matches your notes. You've got it.");
    expect(result.stats.sympyMatches).toBe(1);
  });

  it("makes a difference a question when the second opinion doesn't agree or fails", async () => {
    for (const conflict of [false, new Error("timeout")]) {
      const { generate } = fakeModel(output([usedUp]), conflict);
      const result = await compareNotes(INPUT, deps(generate));
      expect(result.findings.map((f) => f.type)).toEqual(["unclear"]);
      expect(result.stats.secondOpinionDowngrades).toBe(1);
    }
  });

  it("still works when SymPy can't be reached", async () => {
    const { generate } = fakeModel(output([newtonAsDifference]));
    const result = await compareNotes(
      INPUT,
      deps(generate, () => Promise.reject(new Error("down"))),
    );
    expect(result.findings.map((f) => f.type)).toEqual(["difference"]);
  });

  it("drops what the screen told the model to report, if it can't be grounded", async () => {
    const injected: ModelFinding = {
      ...usedUp,
      lineIds: ["L9"],
      noteQuote: "the Earth is flat",
    };
    const { generate } = fakeModel(output([injected], "Every line of your notes is wrong."));
    const result = await compareNotes(INPUT, deps(generate));
    expect(result.findings).toEqual([]);
    expect(result.speech).not.toMatch(/wrong/i);
  });
});

// ─── The whole check ─────────────────────────────────────────────────────────────────────────

const PAGE = "22222222-2222-4222-8222-222222222222";
const LINE_1 = "33333333-3333-4333-8333-000000000001";
const LINE_2 = "33333333-3333-4333-8333-000000000002";

const RETRIEVAL: NotesRetrieval = {
  scope: { kind: "notebook", notebookIds: ["11111111-1111-4111-8111-111111111111"] },
  related: true,
  pages: [
    {
      pageId: PAGE,
      notebookId: "11111111-1111-4111-8111-111111111111",
      notebookTitle: "Biology",
      pageIndex: 2,
    },
  ],
  lines: [
    {
      lineId: LINE_1,
      pageId: PAGE,
      lineIndex: 0,
      bbox: [0, 0, 200, 24],
      source: "ink",
      clipId: null,
      text: "enzymes are used up in the reaction",
      latex: null,
      confidence: 0.9,
      hit: true,
    },
    {
      lineId: LINE_2,
      pageId: PAGE,
      lineIndex: 1,
      bbox: [0, 30, 200, 24],
      source: "ink",
      clipId: null,
      text: "a = F/m",
      latex: null,
      confidence: 0.9,
      hit: false,
    },
  ],
  passages: [],
};

function runDeps(generate: GenerateStructured, overrides: Partial<RunDeps> = {}): RunDeps {
  let n = 0;
  return {
    retrieve: async () => RETRIEVAL,
    save: async (_asker, check) => ({
      checkId: "44444444-4444-4444-8444-444444444444",
      findingIds: check.findings.map(() => "55555555-5555-4555-8555-555555555555"),
    }),
    compare: deps(generate),
    now: () => (n += 100),
    newId: () => "66666666-6666-4666-8666-666666666666",
    ...overrides,
  };
}

const REQUEST = {
  screen: INPUT.screen,
  scope: { kind: "default" as const },
  app: "msedge.exe",
  source: { url: "https://www.youtube.com/watch?v=abc&t=754", title: "Enzymes", timestampSec: 754 },
};

describe("runNotesCheck", () => {
  it("answers 'no related notes' without asking the model", async () => {
    const generate = vi.fn() as unknown as GenerateStructured;
    const result = await runNotesCheck(
      REQUEST,
      { kind: "student" },
      runDeps(generate, {
        retrieve: async () => ({ ...RETRIEVAL, related: false, lines: [], pages: [] }),
      }),
    );
    expect(result).toMatchObject({ related: false, speech: NO_RELATED_NOTES_SPEECH, findings: [] });
    expect(generate).not.toHaveBeenCalled();
  });

  it("maps the prompt's short ids back to the student's lines and stores the findings", async () => {
    const save = vi.fn(runDeps(fakeModel(output([usedUp])).generate).save);
    const { generate } = fakeModel(output([usedUp]));
    const result = await runNotesCheck(
      REQUEST,
      { kind: "device", token: "t" },
      runDeps(generate, { save }),
    );
    expect(result.findings[0]).toMatchObject({
      id: "55555555-5555-4555-8555-555555555555",
      lineIds: [LINE_1],
      type: "difference",
    });
    expect(result.scopeLabel).toBe("Compared with Biology, page 3");
    const stored = save.mock.calls[0]?.[1];
    expect(stored?.findings[0]).toMatchObject({
      noteLineIds: [LINE_1],
      anchorLineId: LINE_1,
      screenSnippet: "Enzymes are not consumed",
    });
    expect(stored?.sourceApp).toBe("msedge.exe");
    expect(stored?.links).toEqual([]); // links come from matches only
  });

  it("links matched lines to the video they were checked against", async () => {
    const match: ModelFinding = {
      ...usedUp,
      type: "match",
      noteQuote: "used up",
      screenQuote: "not consumed",
    };
    const save = vi.fn(runDeps(fakeModel(output([])).generate).save);
    await runNotesCheck(
      REQUEST,
      { kind: "student" },
      runDeps(fakeModel(output([match])).generate, { save }),
    );
    expect(save.mock.calls[0]?.[1].links).toEqual([
      {
        noteLineId: LINE_1,
        finding: 0,
        url: REQUEST.source.url,
        title: "Enzymes",
        timestampSec: 754,
      },
    ]);
  });

  it("still answers when the findings can't be stored", async () => {
    const { generate } = fakeModel(output([usedUp]));
    const result = await runNotesCheck(
      REQUEST,
      { kind: "student" },
      runDeps(generate, {
        save: () => Promise.reject(new Error("db down")),
      }),
    );
    expect(result.checkId).toBeNull();
    expect(result.findings[0]?.id).toBe("66666666-6666-4666-8666-666666666666");
  });
});
