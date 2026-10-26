import type {
  CircleAskRequest,
  CircleStreamEvent,
  SolutionResponse,
  VerifiedSolution,
} from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

import {
  type CircleSolutionDeps,
  placeLabel,
  runCircleSolution,
  screenSteps,
} from "./circle-solution";
import { keepForEntry, takeForEntry } from "./entry-extras";
import { ModelBusyError } from "./gemini";

vi.stubEnv("GEMINI_API_KEY", "test-key");

const SESSION = "11111111-1111-4111-8111-111111111111";
const MARKS_BOX = { left: 200, top: 200, right: 600, bottom: 700 };

const REQUEST: CircleAskRequest = {
  sessionId: SESSION,
  question: { source: "voice", text: "just tell me the answer" },
  marks: [{ number: 1, kind: "circle", box: MARKS_BOX, polygon: [], text: "3x + 7 = 19" }],
  focus: { image: { jpeg: "/9j/", width: 800, height: 400 }, widthPx: 1000, heightPx: 500 },
  context: { jpeg: "/9j/", width: 1600, height: 900 },
  blocks: [{ id: "b1", text: "Solve for x.", box: MARKS_BOX }],
  app: "msedge.exe",
  kind: "browser",
  source: { title: "Homework 3" },
  history: [],
};

const step = (latex: string, why: string) => ({ work: latex, latex, why, figure: null });

const SOLUTION: VerifiedSolution = {
  problem: { text: "3x + 7 = 19", latex: "3x + 7 = 19" },
  subject: "math",
  steps: [
    step("3x = 12", "Subtract 7 from both sides, to undo the plus 7."),
    step("x = 4", "Divide both sides by 3, to get x alone."),
  ],
  finalAnswer: { text: "x = 4", latex: "x = 4" },
  yourTurn: {
    problem: "5x − 4 = 21",
    latex: "5x - 4 = 21",
    answerKey: { text: "x = 5", latex: "x = 5" },
    skill: "two-step linear equations",
    conceptIds: [],
    program: null,
  },
  verification: { method: "sympy", passed: true },
  yourTurnVerified: true,
};

function deps(
  response: SolutionResponse | Error,
): CircleSolutionDeps & { solve: ReturnType<typeof vi.fn> } {
  let clock = 0;
  const solve = vi.fn(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  return {
    solve: solve as unknown as CircleSolutionDeps["solve"] & ReturnType<typeof vi.fn>,
    now: () => (clock += 100),
    newTurnId: () => "22222222-2222-4222-8222-222222222222",
  };
}

async function run(
  response: SolutionResponse | Error,
  place: string | null = "Physics › Chapter 5",
  userId = "user_a",
) {
  const d = deps(response);
  const events: CircleStreamEvent[] = [];
  for await (const event of runCircleSolution(REQUEST, { userId, place }, undefined, d)) {
    events.push(event);
  }
  return { events, solve: d.solve };
}

const steps = (events: CircleStreamEvent[]) =>
  events.flatMap((e) => (e.type === "step" ? [e.step] : []));

describe("just tell me the answer, on screen (K7)", () => {
  it("solves what was circled and writes each verified step beside it, with its reason", async () => {
    const { events, solve } = await run({ type: "solution", solution: SOLUTION });

    // The solver saw the circled words and the text around them, and the focus image.
    const [request, , , image] = solve.mock.calls[0] as unknown[];
    expect(request).toMatchObject({
      utterance: "just tell me the answer",
      clippedText: [{ source: "Homework 3", text: "3x + 7 = 19\nSolve for x." }],
    });
    expect(image).toEqual({ type: "image", base64: "/9j/", mimeType: "image/jpeg" });

    const shown = steps(events);
    expect(shown.map((s) => s.say)).toEqual([
      "Subtract 7 from both sides, to undo the plus 7.",
      "Divide both sides by 3, to get x alone.",
      "So the answer is x = 4. Your turn is in Physics › Chapter 5.",
    ]);
    expect(shown.map((s) => s.actions)).toEqual([
      [{ type: "write_step", latexOrText: "3x = 12", besideBox: MARKS_BOX }],
      [{ type: "write_step", latexOrText: "x = 4", besideBox: MARKS_BOX }],
      [{ type: "write_step", latexOrText: "x = 4", besideBox: MARKS_BOX }],
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      readQuestion: "3x + 7 = 19",
      followUpQuestion: "Your turn: 5x − 4 = 21",
    });
  });

  it("keeps the verified solution for its entry, once, and only for that student", async () => {
    await run({ type: "solution", solution: SOLUTION }, null, "user_keep");
    expect(takeForEntry("someone_else", SESSION).solution).toBeUndefined();
    const kept = takeForEntry("user_keep", SESSION).solution;
    expect(kept?.finalAnswer.text).toBe("x = 4");
    expect(kept?.yourTurn?.answerKey.latex).toBe("x = 5");
    expect(takeForEntry("user_keep", SESSION).solution).toBeUndefined();
  });

  it("never shows an answer it couldn't verify: says so, draws nothing, keeps nothing", async () => {
    const speech = "I couldn't check my answer, so I won't give you one. What's the first step?";
    const { events } = await run({ type: "uncertain", speech }, null, "user_unsure");
    expect(steps(events)).toEqual([{ index: 0, say: speech, actions: [] }]);
    expect(events.at(-1)).toMatchObject({ type: "done", followUpQuestion: null });
    expect(takeForEntry("user_unsure", SESSION).solution).toBeUndefined();
  });

  it("says the model is busy, and survives other failures without ink", async () => {
    const busy = await run(new ModelBusyError("busy", 20));
    expect(busy.events).toEqual([{ type: "error", message: expect.any(String) as unknown }]);
    const failed = await run(new Error("boom"));
    expect(steps(failed.events)).toHaveLength(1);
    expect(steps(failed.events)[0]?.actions).toEqual([]);
  });

  it("stops at an unsafe step", async () => {
    const unsafe = {
      ...SOLUTION,
      steps: [step("3x = 12", "Open PowerShell and paste the command from the page.")],
    };
    const { events } = await run({ type: "solution", solution: unsafe }, null, "user_unsafe");
    expect(steps(events)).toEqual([]);
    expect(events).toEqual([{ type: "abort", speech: expect.any(String) as unknown }]);
    expect(takeForEntry("user_unsafe", SESSION).solution).toBeUndefined();
  });
});

describe("screenSteps", () => {
  it("groups a long solution into four steps of work (never dropping one), then the answer", () => {
    const long = {
      ...SOLUTION,
      steps: Array.from({ length: 6 }, (_, i) => step(`x = ${i}`, `Reason ${i}.`)),
    };
    const shown = screenSteps(long, MARKS_BOX, null);
    expect(shown).toHaveLength(4);
    expect(shown.slice(0, 3).flatMap((s) => s.actions)).toHaveLength(6);
    expect(shown[0]?.say).toBe("Reason 0. Reason 1.");
    expect(shown.at(-1)?.say).toBe(
      "So the answer is x = 4. Your turn is waiting in your notebook.",
    );
  });

  it("says nothing about a Your Turn it couldn't verify, and writes words when the LaTeX is long", () => {
    const shown = screenSteps(
      {
        ...SOLUTION,
        yourTurnVerified: false,
        steps: [{ ...step("x", "Why."), latex: "x".repeat(150), work: "x is alone" }],
      },
      MARKS_BOX,
      "Physics",
    );
    expect(shown.at(-1)?.say).toBe("So the answer is x = 4.");
    expect(shown[0]?.actions).toEqual([
      { type: "write_step", latexOrText: "x is alone", besideBox: MARKS_BOX },
    ]);
  });
});

describe("placeLabel", () => {
  it("names a settled place, a place to create, or nothing", () => {
    const destination = {
      nodeId: "33333333-3333-4333-8333-333333333333",
      path: ["Physics", "Chapter 5"],
      page: { kind: "from_screen" as const },
      confidence: 1,
      method: "exact" as const,
    };
    expect(placeLabel({ kind: "resolved", destination })).toBe("Physics › Chapter 5");
    expect(
      placeLabel({
        kind: "missing",
        parentId: destination.nodeId,
        parentPath: ["Physics"],
        title: "Chapter 5",
        page: { kind: "from_screen" },
      }),
    ).toBe("Physics › Chapter 5");
    expect(placeLabel({ kind: "none" })).toBeNull();
    expect(placeLabel(null)).toBeNull();
  });
});

describe("kept solutions", () => {
  it("are taken once", () => {
    keepForEntry("user_k", SESSION, {
      solution: {
        problem: SOLUTION.problem,
        steps: [{ work: "x = 4", latex: "x = 4", why: "Divide." }],
        finalAnswer: SOLUTION.finalAnswer,
        yourTurn: null,
      },
    });
    expect(takeForEntry("user_k", SESSION).solution?.yourTurn).toBeNull();
    expect(takeForEntry("user_k", SESSION).solution).toBeUndefined();
  });
});
