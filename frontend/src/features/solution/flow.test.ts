import { type Line, PageDocument, strokeBBox } from "@mew/ink";
import type {
  BBox,
  Evidence,
  ImageBlock,
  LineCheck,
  MathCheckResponse,
  Point,
  SolutionResponse,
  Stroke,
  VerifiedSolution,
} from "@mew/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CodeRun } from "../check/checker";
import type { PageEngine } from "../notebook/engine";
import { useNotebookUi } from "../notebook/store";
import { type InkClock, TutorInk } from "../tutor/ink";
import { solutionRegion } from "../notebook/clip-page";
import { linesIn, ShowThenYou, type ShowThenYouDeps } from "./flow";
import type { LocalSolution } from "./record";
import { useShowThenYou } from "./store";

const PAGE = "00000000-0000-4000-8000-0000000000aa";
const CONCEPT = "00000000-0000-4000-8000-0000000000c1";
const COLORS = { ink: "#8a7bf0", error: "#c8432b", correct: "#2f7d55" };
let n = 0;
const newId = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;

/** Each line's solution, as SymPy would see it (x for every equation here). */
const SOLUTIONS: Record<string, number> = {
  "3x + 7 = 19": 4,
  "3x = 12": 4,
  "x = 4": 4,
  "5x - 4 = 21": 5,
  "5x = 25": 5,
  "5x = 17": 3.4,
  "x = 5": 5,
  // A physics Your Turn, on its numbers (K7): s = ½ · 3 · 4² = 24.
  [String.raw`s = \frac{1}{2} \cdot 3 \cdot 4^2`]: 24,
  [String.raw`s = \frac{1}{2} \cdot 3 \cdot 16`]: 24,
  "s = 24": 24,
};

/** SymPy, faked: a line is correct when it has the same solution as the line before. */
function checkMath(steps: string[]): Promise<MathCheckResponse["results"]> {
  return Promise.resolve(
    steps.map((step, index) => {
      const before = SOLUTIONS[steps[index - 1] ?? ""];
      const now = SOLUTIONS[step];
      if (index === 0 || before === undefined || now === undefined) {
        return { index, verdict: "unknown" as const, reason: "unparsed" };
      }
      return before === now
        ? { index, verdict: "correct" as const, reason: "equivalent" }
        : { index, verdict: "incorrect" as const, reason: "not_equivalent" };
    }),
  );
}

const SOLUTION: VerifiedSolution = {
  problem: { text: "3x + 7 = 19", latex: "3x + 7 = 19" },
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
  yourTurn: {
    problem: "5x − 4 = 21",
    latex: "5x - 4 = 21",
    answerKey: { text: "x = 5", latex: "x = 5" },
    skill: "two-step linear equations",
    conceptIds: [CONCEPT],
    program: null,
  },
  verification: { method: "sympy", passed: true },
  yourTurnVerified: true,
};

/** Python, faked: what each program (as rebuilt from the lines) gives when run. */
const PROGRAMS: Record<string, CodeRun> = {
  "print(sum([1, 2, 3]))": { ok: true, output: "6\n" },
  "total = 1 + 2 + 3\nprint(total)": { ok: true, output: "6\n" },
  "total = 1 + 2\nprint(total)": { ok: true, output: "3\n" },
  "total = 1 + 2 + 3\nprint(totl)": {
    ok: false,
    output: "",
    error: "NameError: name 'totl' is not defined",
    line: 2,
  },
};
const runCode = (source: string): Promise<CodeRun> =>
  Promise.resolve(PROGRAMS[source] ?? { ok: false, output: "", error: "SyntaxError", line: 1 });

/** A clock that's always far ahead: every bit of ink is written on its first frame. */
const instantClock: InkClock = (() => {
  let now = 0;
  return {
    now: () => (now += 100_000),
    frame: (fn) => {
      const id = setTimeout(fn, 0);
      return () => clearTimeout(id);
    },
    timeout: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  };
})();

function stroke(x: number, y: number): Stroke {
  const points: Point[] = [
    [x, y + 24, 0.5, 0],
    [x + 8, y, 0.5, 10],
    [x + 16, y + 24, 0.5, 20],
  ];
  return {
    id: newId(),
    pageId: PAGE,
    author: "student",
    tool: "pen",
    points,
    color: "#1d1c1a",
    width: 3,
    bbox: strokeBBox(points, 3),
    createdAt: n,
  };
}

/** A written line: a few letters side by side. */
const written = (x: number, y: number) =>
  Array.from({ length: 5 }, (_, i) => stroke(x + i * 20, y));

function setup({
  response = { type: "solution", solution: SOLUTION } as SolutionResponse,
  yourTurnWanted = true,
  images = [] as ImageBlock[],
  strokes = written(100, 100), // 3x + 7 = 19
} = {}) {
  const doc = new PageDocument(strokes);
  const engine = {
    pageId: PAGE,
    doc,
    images,
    addTutorStrokes: (list: readonly Stroke[]) => doc.add(list),
  } as unknown as PageEngine;
  const ink = new TutorInk({
    engine: () => engine,
    colors: () => COLORS,
    newId,
    clock: instantClock,
  });
  ink.attachViewport(() => [0, 0, 1200, 900]);

  /** What the student's lines say, by line id (the rest can't be read). */
  const readings = new Map<string, string>();
  const said: string[] = [];
  const attempts: { conceptIds: readonly string[]; evidence: Evidence; source: string }[] = [];
  const hints: LineCheck[][] = [];
  const saved: LocalSolution[] = [];
  const deps: ShowThenYouDeps = {
    engine: () => engine,
    ink,
    say: (text) => {
      said.push(text);
      return Promise.resolve();
    },
    request: () =>
      Promise.resolve({
        utterance: "just give me the answer",
        recognizedLines: [],
        pageImage: null,
        clippedText: [],
        courseContext: [],
        concepts: [],
        variantOf: null,
      }),
    solve: vi.fn(() => Promise.resolve(response)),
    checkMath,
    runCode: vi.fn(runCode),
    read: (_doc, line) => Promise.resolve(readings.get(line.id) ?? null),
    hintTurn: (checks) => hints.push(checks),
    hintStep: vi.fn(),
    attempt: (conceptIds, evidence, source) => attempts.push({ conceptIds, evidence, source }),
    review: vi.fn(),
    save: (record) => {
      saved.push(structuredClone(record));
      return Promise.resolve();
    },
    courseId: () => "course",
    yourTurnWanted: () => yourTurnWanted,
    newId,
    now: () => n,
  };
  const flow = new ShowThenYou(deps);

  /** The student writes lines in the Your Turn box, top to bottom, each read as given. */
  const answer = (...texts: string[]): Line[] => {
    const region = useShowThenYou.getState().solutions.at(-1)?.yourTurn?.region;
    if (!region) throw new Error("no Your Turn box");
    const [x, y] = region;
    texts.forEach((_, i) => doc.add(written(x + 10, y + 8 + i * 50)));
    const lines = linesIn(engine, region);
    lines.forEach((line, i) => {
      const text = texts[i];
      if (text) readings.set(line.id, text);
    });
    return lines;
  };

  return { flow, deps, doc, said, attempts, hints, saved, answer };
}

beforeEach(() => {
  useShowThenYou.setState({
    phase: "idle",
    solutions: [],
    peeking: new Set(),
    offerHint: false,
    offerSolution: false,
    finished: null,
  });
  useNotebookUi.getState().setFoldedGroups(new Set());
});

describe("Show-then-You in the notebook (K6)", () => {
  it("writes each step with its reason, boxes the answer, folds it and writes a Your Turn", async () => {
    const { flow, doc, said, attempts, saved } = setup();
    await flow.run("just give me the answer");

    expect(said).toEqual([
      "Subtract 7 from both sides, to undo the plus 7.",
      "Divide both sides by 3, to get x alone.",
      "So the answer is x = 4.",
      "Your turn: try this one on your own.",
    ]);
    const record = useShowThenYou.getState().solutions.at(-1);
    expect(record?.folded).toBe(true);
    // The worked solution is folded away: its ink is hidden until a peek.
    expect(useNotebookUi.getState().foldedGroups.has(record?.groupId ?? "")).toBe(true);
    const solutionInk = doc.all().filter((s) => s.groupId === record?.groupId);
    expect(solutionInk.length).toBeGreaterThan(0);
    // The Your Turn box is ink of its own, never folded.
    expect(record?.yourTurn?.status).toBe("open");
    expect(record?.yourTurn?.region[3]).toBeGreaterThan(0);
    expect(useNotebookUi.getState().foldedGroups.has(record?.yourTurn?.groupId ?? "")).toBe(false);
    expect(useShowThenYou.getState().phase).toBe("your_turn");
    // The original problem was explained, so it's no mastery (§6.5).
    expect(attempts).toEqual([
      { conceptIds: [CONCEPT], evidence: "after_explanation", source: "practice" },
    ]);
    expect(saved.at(-1)?.yourTurn?.problem).toBe("5x − 4 = 21");
  });

  it("never shows a solution it couldn't verify: it says so and draws nothing", async () => {
    const speech = "I couldn't check my answer, so let's do it together: what's the first step?";
    const { flow, doc, said, attempts } = setup({ response: { type: "uncertain", speech } });
    const before = doc.all().length;
    await flow.run("solve it");

    expect(said).toEqual([speech]);
    expect(doc.all()).toHaveLength(before);
    expect(attempts).toEqual([]);
    expect(useShowThenYou.getState().phase).toBe("idle");
  });

  it("gives no Your Turn when its answer key wasn't verified, or the student turned it off", async () => {
    for (const options of [
      { response: { type: "solution", solution: { ...SOLUTION, yourTurnVerified: false } } },
      { yourTurnWanted: false },
    ] as const) {
      useShowThenYou.setState({ solutions: [], phase: "idle" });
      const { flow, said } = setup(options);
      await flow.run("just give me the answer");
      expect(said).not.toContain("Your turn: try this one on your own.");
      expect(useShowThenYou.getState().solutions.at(-1)?.yourTurn).toBeNull();
      expect(useShowThenYou.getState().phase).toBe("idle");
    }
  });

  it("ticks correct lines and logs a Your Turn solved alone as independent", async () => {
    const { flow, deps, doc, attempts, said, answer } = setup();
    await flow.run("just give me the answer");
    const lines = answer("5x = 25", "x = 5");
    const before = doc.all().length;

    expect(await flow.check({ quiet: false })).toBe(true);
    await deps.ink.written();

    const ticks = doc.all().slice(before);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((s) => s.author === "tutor")).toBe(true);
    expect(lines).toHaveLength(2);
    expect(attempts.at(-1)).toEqual({
      conceptIds: [CONCEPT],
      evidence: "independent",
      source: "your_turn",
    });
    expect(said.at(-1)).toBe("You got it on your own.");
    expect(useShowThenYou.getState().phase).toBe("done");
  });

  it("isn't done at a step that's only equivalent to the answer (5x = 25 on the way to x = 5)", async () => {
    const { flow, attempts, said, answer } = setup();
    await flow.run("just give me the answer");
    answer("5x = 25");

    await flow.check({ quiet: false });

    expect(useShowThenYou.getState().phase).toBe("your_turn");
    expect(attempts.filter((a) => a.source === "your_turn")).toEqual([]);
    expect(said.at(-1)).toBe("So far so good. Keep going.");
  });

  it("circles a wrong line with a hint, offers a hint step after two misses, and then it's with_hint", async () => {
    const { flow, deps, doc, attempts, hints, answer } = setup();
    await flow.run("just give me the answer");
    const [wrong] = answer("5x = 17");

    await flow.check({ quiet: true });
    await flow.check({ quiet: true });
    expect(hints).toHaveLength(2);
    // Only the wrong line is the target: it gets the circle and the smallest hint.
    expect(hints[0]?.filter((c) => c.target).map((c) => c.lineId)).toEqual([wrong?.id]);
    expect(hints[0]?.find((c) => c.target)?.verdict).toBe("incorrect");
    expect(useShowThenYou.getState().offerHint).toBe(true);
    expect(attempts.filter((a) => a.source === "your_turn")).toEqual([]);

    await flow.takeHintStep();
    expect(deps.hintStep).toHaveBeenCalledOnce();
    // The student rubs the wrong line out and solves it.
    doc.remove(wrong?.strokeIds ?? []);
    answer("5x = 25", "x = 5");
    await flow.check({ quiet: false });
    expect(attempts.at(-1)).toEqual({
      conceptIds: [CONCEPT],
      evidence: "with_hint",
      source: "your_turn",
    });
  });

  it("counts a peek at the folded solution as a hint", async () => {
    const { flow, attempts, answer } = setup();
    await flow.run("just give me the answer");
    const record = useShowThenYou.getState().solutions.at(-1);
    if (!record) throw new Error("no solution");

    await flow.peek(record.id);
    expect(useNotebookUi.getState().foldedGroups.has(record.groupId)).toBe(false);
    await flow.peek(record.id);
    expect(useNotebookUi.getState().foldedGroups.has(record.groupId)).toBe(true);

    answer("5x = 25", "x = 5");
    await flow.check({ quiet: false });
    expect(attempts.at(-1)?.evidence).toBe("with_hint");
  });

  it("skipping logs nothing and puts the concepts in the review queue", async () => {
    const { flow, deps, attempts } = setup();
    await flow.run("just give me the answer");
    await flow.skip();

    expect(deps.review).toHaveBeenCalledWith([CONCEPT]);
    expect(attempts.filter((a) => a.source === "your_turn")).toEqual([]);
    expect(useShowThenYou.getState().solutions.at(-1)?.yourTurn?.status).toBe("skipped");
    expect(await flow.check({ quiet: false })).toBe(false); // nothing open to check any more
  });

  it("leaves checks outside the Your Turn box to the usual checker", async () => {
    const { flow, doc } = setup();
    await flow.run("just give me the answer");
    const engine = { pageId: PAGE, doc } as unknown as PageEngine;
    expect(flow.owns(engine)).toBe(false); // the box is still empty
  });
});

describe("offering the answer after two wrong tries (K6 §6)", () => {
  it("offers it after two wrong lines in a row, and a right line starts the count again", () => {
    const { flow } = setup();
    flow.tried(PAGE, false);
    flow.tried(PAGE, true);
    flow.tried(PAGE, false);
    expect(useShowThenYou.getState().offerSolution).toBe(false);
    flow.tried(PAGE, false);
    expect(useShowThenYou.getState().offerSolution).toBe(true);
  });

  it("never offers it for another page, or while a Your Turn is open", async () => {
    const { flow } = setup();
    flow.tried("another-page", false);
    flow.tried("another-page", false);
    expect(useShowThenYou.getState().offerSolution).toBe(false);

    await flow.run("just give me the answer");
    flow.tried(PAGE, false);
    flow.tried(PAGE, false);
    expect(useShowThenYou.getState().offerSolution).toBe(false);
  });

  it("runs Show-then-You when accepted; declining waits for two more wrong tries", async () => {
    const { flow, deps } = setup();
    flow.tried(PAGE, false);
    flow.tried(PAGE, false);
    flow.declineOffer();
    expect(useShowThenYou.getState().offerSolution).toBe(false);
    flow.tried(PAGE, false);
    expect(useShowThenYou.getState().offerSolution).toBe(false);
    flow.tried(PAGE, false);
    expect(useShowThenYou.getState().offerSolution).toBe(true);

    await flow.acceptOffer();
    expect(deps.solve).toHaveBeenCalledOnce();
    expect(useShowThenYou.getState()).toMatchObject({ offerSolution: false, phase: "your_turn" });
  });
});

describe("linesIn", () => {
  it("takes the lines whose middle is in the box, top to bottom", () => {
    const doc = new PageDocument([
      ...written(100, 300),
      ...written(100, 100),
      ...written(600, 100),
    ]);
    const engine = { doc } as unknown as PageEngine;
    const box: BBox = [80, 80, 300, 300];
    const tops = linesIn(engine, box).map((l) => l.bbox[1]);
    expect(tops).toHaveLength(2); // the line at x = 600 is outside
    expect(tops[0]).toBeLessThan(tops[1] ?? 0);
  });
});

describe("a worked solution saved from the screen (K7)", () => {
  const image: ImageBlock = {
    id: "00000000-0000-4000-8000-0000000000e1",
    pageId: PAGE,
    type: "image",
    clipId: "00000000-0000-4000-8000-0000000000c9",
    x: 40,
    y: 60,
    width: 600,
    height: 300,
    createdAt: 1,
    entry: {
      sessionId: "00000000-0000-4000-8000-0000000000d1",
      turns: [{ question: "3x + 7 = 19", steps: ["Subtract 7."], summary: "Worked solution." }],
      stepGroups: [[]],
      strokeCount: 0,
      solution: {
        problem: SOLUTION.problem,
        steps: SOLUTION.steps.map(({ work, latex, why }) => ({ work, latex, why })),
        finalAnswer: SOLUTION.finalAnswer,
        yourTurn: {
          problem: "5x − 4 = 21",
          latex: "5x - 4 = 21",
          answerKey: { text: "x = 5", latex: "x = 5" },
          skill: "two-step linear equations",
        },
      },
    },
  };

  it("is written folded under the entry's note, with its Your Turn, once and quietly", async () => {
    const { flow, doc, said, answer, attempts } = setup({ images: [image], strokes: [] });
    await flow.adoptEntries();

    const record = useShowThenYou.getState().solutions.at(-1);
    expect(record?.id).toBe(`entry:${image.id}`);
    expect(record?.folded).toBe(true);
    expect(useNotebookUi.getState().foldedGroups.has(record?.groupId ?? "")).toBe(true);
    expect(said).toEqual([]); // nobody was watching: nothing is said
    // Everything is under the picture and its note.
    const [, top] = solutionRegion(image);
    const tutor = doc.all().filter((s) => s.author === "tutor");
    expect(tutor.length).toBeGreaterThan(0);
    expect(tutor.every((s) => s.bbox[1] >= top - 1)).toBe(true);
    expect(useShowThenYou.getState().phase).toBe("your_turn");

    // Opening the page again doesn't write it twice.
    const count = doc.all().length;
    await flow.adoptEntries();
    expect(doc.all()).toHaveLength(count);

    // The Your Turn is checked like any other (no concepts from the screen: no evidence).
    answer("5x = 25", "x = 5");
    await flow.check({ quiet: false });
    expect(useShowThenYou.getState().phase).toBe("done");
    expect(attempts).toEqual([{ conceptIds: [], evidence: "independent", source: "your_turn" }]);
  });
});

describe("a physics Your Turn (K7)", () => {
  const tex = String.raw;
  const physics: VerifiedSolution = {
    ...SOLUTION,
    subject: "physics",
    yourTurn: {
      problem: "A bike accelerates from rest at 3 m/s² for 4 s. How far does it travel?",
      latex: tex`s = \frac{1}{2} \cdot 3 \cdot 4^2`,
      answerKey: { text: "24 m", latex: tex`s = 24 \text{ m}` },
      skill: "distance under constant acceleration",
      conceptIds: [CONCEPT],
      program: null,
    },
  };

  it("leaves the student's formula alone, checks the numbers, and takes the answer with its unit", async () => {
    const { flow, hints, attempts, answer } = setup({
      response: { type: "solution", solution: physics },
    });
    await flow.run("just give me the answer");
    answer(
      tex`s = \frac{1}{2} a t^2`,
      tex`s = \frac{1}{2} \cdot 3 \cdot 16`,
      tex`s = 24 \text{ m}`,
    );

    await flow.check({ quiet: false });

    expect(hints).toEqual([]); // the formula is never circled as a wrong step
    expect(useShowThenYou.getState().phase).toBe("done");
    expect(attempts.at(-1)).toEqual({
      conceptIds: [CONCEPT],
      evidence: "independent",
      source: "your_turn",
    });
  });
});

describe("a chemistry Your Turn", () => {
  const chemistry: VerifiedSolution = {
    ...SOLUTION,
    subject: "chemistry",
    yourTurn: {
      problem: "Balance the equation: Mg + O2 → MgO",
      latex: String.raw`Mg + O_2 \to MgO`,
      answerKey: { text: "2Mg + O2 → 2MgO", latex: String.raw`2Mg + O_2 \to 2MgO` },
      skill: "balancing equations",
      conceptIds: [CONCEPT],
      program: null,
    },
  };

  it("circles an unbalanced line with the counts, and is done when it's balanced", async () => {
    const { flow, doc, hints, attempts, answer } = setup({
      response: { type: "solution", solution: chemistry },
    });
    await flow.run("just give me the answer");
    const [first] = answer("Mg + O2 -> MgO");

    await flow.check({ quiet: true });
    expect(hints).toHaveLength(1);
    expect(hints[0]?.[0]).toMatchObject({
      checker: "chemistry",
      verdict: "incorrect",
      detail: "O: 2 on the left, 1 on the right",
    });

    doc.remove(first?.strokeIds ?? []);
    answer("2Mg + O2 -> 2MgO");
    await flow.check({ quiet: false });
    expect(useShowThenYou.getState().phase).toBe("done");
    expect(attempts.at(-1)?.evidence).toBe("independent");
  });

  it("leaves another reaction alone", async () => {
    const { flow, hints, answer } = setup({ response: { type: "solution", solution: chemistry } });
    await flow.run("just give me the answer");
    answer("2Na + Cl2 -> 2NaCl");
    await flow.check({ quiet: true });
    expect(hints).toEqual([]);
    expect(useShowThenYou.getState().phase).toBe("your_turn");
  });
});

describe("a code Your Turn", () => {
  const code: VerifiedSolution = {
    ...SOLUTION,
    subject: "programming",
    yourTurn: {
      problem: "Write a program that adds 1, 2 and 3 and prints the total.",
      latex: null,
      answerKey: { text: "6", latex: null },
      skill: "adding numbers in Python",
      conceptIds: [CONCEPT],
      program: "print(sum([1, 2, 3]))",
    },
  };
  const solved = { type: "solution", solution: code } as const;

  it("runs the reference program first, and shows no Your Turn when it doesn't print the key", async () => {
    const wrongKey = {
      ...code,
      yourTurn: { ...code.yourTurn, answerKey: { text: "7", latex: null } },
    };
    const { flow, deps, said } = setup({ response: { type: "solution", solution: wrongKey } });
    await flow.run("just give me the answer");

    expect(deps.runCode).toHaveBeenCalledWith("print(sum([1, 2, 3]))");
    expect(useShowThenYou.getState().solutions.at(-1)?.yourTurn).toBeNull();
    expect(said).not.toContain("Your turn: try this one on your own.");
  });

  it("is done when the student's program prints the key, solved alone", async () => {
    const { flow, attempts, answer } = setup({ response: solved });
    await flow.run("just give me the answer");
    answer("total = 1 + 2 + 3", "print(total)");

    await flow.check({ quiet: true }); // a pen pause can finish it
    expect(useShowThenYou.getState().phase).toBe("done");
    expect(attempts.at(-1)).toEqual({
      conceptIds: [CONCEPT],
      evidence: "independent",
      source: "your_turn",
    });
  });

  it("marks only when asked: the failing line, or the last one when it prints something else", async () => {
    const { flow, hints, answer, doc } = setup({ response: solved });
    await flow.run("just give me the answer");
    const lines = answer("total = 1 + 2 + 3", "print(totl)");

    await flow.check({ quiet: true });
    expect(hints).toEqual([]); // a program being written isn't circled on a pause
    await flow.check({ quiet: false });
    expect(hints.at(-1)).toEqual([
      expect.objectContaining({ lineId: lines[1]?.id, checker: "code", reason: "error" }),
    ]);

    doc.remove(lines.flatMap((l) => l.strokeIds));
    const again = answer("total = 1 + 2", "print(total)");
    await flow.check({ quiet: false });
    expect(hints.at(-1)).toEqual([
      expect.objectContaining({
        lineId: again[1]?.id,
        reason: "wrong_output",
        detail: "It printed: 3",
      }),
    ]);
    expect(useShowThenYou.getState().phase).toBe("your_turn");
  });
});
