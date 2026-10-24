import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  checkedStep,
  CircleAskModelResponse,
  CircleAskRequest,
  clipWords,
  marksBox,
  questionText,
  ReadQuestionResponse,
} from "./circle";
import { EntryPart } from "./clips";
import { renderCircleInput } from "./prompts/circle";
import { circleAnswerReasons, circleStepReasons } from "./screen-safety";

const IMAGE = { jpeg: "/9j/4AAQ", width: 800, height: 400 };
const SESSION = "11111111-1111-4111-8111-111111111111";

const REQUEST = {
  sessionId: SESSION,
  question: { source: "typed", text: "why does this go up here?" },
  marks: [
    {
      number: 1,
      kind: "circle",
      box: { left: 200, top: 200, right: 600, bottom: 700 },
      polygon: [
        { x: 200, y: 450 },
        { x: 400, y: 200 },
        { x: 600, y: 450 },
      ],
      text: "velocity (m/s)",
    },
  ],
  focus: { image: IMAGE, widthPx: 1000, heightPx: 500 },
  context: { jpeg: "/9j/", width: 1600, height: 900 },
  blocks: [
    {
      id: "b1",
      text: "Figure 2: a velocity–time graph",
      box: { left: 0, top: 800, right: 1000, bottom: 900 },
    },
  ],
  app: "msedge.exe",
  kind: "video",
  history: [],
} as const;

const LIMITS = {
  marks: { left: 200, top: 200, right: 600, bottom: 700 },
  widthPx: 1000,
  heightPx: 500,
};

describe("circle-ask schemas", () => {
  it("accepts a request with every way of asking", () => {
    expect(CircleAskRequest.parse(REQUEST).marks).toHaveLength(1);
    for (const question of [
      { source: "voice", text: "what's this?" },
      { source: "screen_selection", text: "Q3: find a", handwritten: true, confidence: 0.6 },
      { source: "none" },
    ]) {
      expect(CircleAskRequest.safeParse({ ...REQUEST, question }).success).toBe(true);
    }
    expect(questionText({ source: "none" })).toBeNull();
    expect(questionText({ source: "typed", text: "why?" })).toBe("why?");
  });

  it("refuses more than three marks, empty questions and links that aren't https", () => {
    const mark = REQUEST.marks[0];
    for (const bad of [
      { ...REQUEST, marks: [] },
      {
        ...REQUEST,
        marks: [1, 2, 3, 4].map((number) => ({ ...mark, number: Math.min(number, 3) })),
      },
      { ...REQUEST, question: { source: "typed", text: "  " } },
      { ...REQUEST, source: { url: "http://example.com/" } },
      { ...REQUEST, marks: [{ ...mark, number: 4 }] },
      { ...REQUEST, blocks: [{ id: "x1", text: "a", box: mark.box }] },
    ]) {
      expect(CircleAskRequest.safeParse(bad).success).toBe(false);
    }
  });

  it("can describe the model's answer to Gemini", () => {
    const json = JSON.stringify(z.toJSONSchema(CircleAskModelResponse));
    expect(json).not.toContain("prefixItems");
    // Actions come before the words in each step, so a step's ink streams first.
    expect(json.indexOf('"actions"')).toBeLessThan(json.indexOf('"say"'));
    expect(
      ReadQuestionResponse.parse({ questions: ["Find x"], handwritten: true, confidence: 0.9 })
        .questions,
    ).toEqual(["Find x"]);
  });

  it("describes an entry's part with each stroke's step", () => {
    const part = EntryPart.parse({
      sessionId: SESSION,
      studentStrokes: [],
      turn: { question: "Explain this", steps: ["One.", "Two."], summary: "S." },
      strokeSteps: [0, 0, 1],
      conceptHints: ["Acceleration"],
    });
    expect(part.turn.steps).toHaveLength(2);
    expect(EntryPart.safeParse({ ...part, strokeSteps: [5] }).success).toBe(false);
  });
});

describe("checking a step", () => {
  it("keeps ink near the marks and drops the rest", () => {
    const step = checkedStep(
      {
        actions: [
          { type: "underline", box: { left: 220, top: 600, right: 580, bottom: 620 } },
          // 100 units = 100 px wide outside: within the 120 px margin.
          { type: "point_at", point: { x: 700, y: 400 } },
          // Across the far side of the screen: dropped.
          { type: "circle_region", box: { left: 0, top: 0, right: 1000, bottom: 1000 } },
          { type: "focus_region", box: LIMITS.marks, kind: "figure" },
          {
            type: "margin_note",
            text: "far too many words for a margin note",
            besideBox: LIMITS.marks,
          },
          { type: "margin_note", text: "a = 0", besideBox: LIMITS.marks },
        ],
        say: "This axis is velocity, not position.",
      },
      0,
      LIMITS,
    );
    expect(step.actions.map((a) => a.type)).toEqual(["underline", "point_at", "margin_note"]);
    expect(step.say).toBe("This axis is velocity, not position.");
  });

  it("cuts the words to 25", () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    const step = checkedStep({ actions: [], say: long }, 1, LIMITS);
    expect(step.say.split(" ")).toHaveLength(25);
    expect(step.say.endsWith("…")).toBe(true);
    expect(clipWords("Short, sweet.", 25)).toBe("Short, sweet.");
    expect(clipWords("one two three, four", 3)).toBe("one two three…");
  });

  it("finds the box around every mark", () => {
    expect(
      marksBox([
        { box: { left: 10, top: 20, right: 30, bottom: 40 } },
        { box: { left: 5, top: 25, right: 50, bottom: 35 } },
      ]),
    ).toEqual({ left: 5, top: 20, right: 50, bottom: 40 });
  });
});

describe("circle-ask safety", () => {
  it("checks what's said and written in a step", () => {
    expect(circleStepReasons({ say: "This is the slope.", actions: [] })).toEqual([]);
    expect(
      circleStepReasons({
        say: "Look here.",
        actions: [{ type: "margin_note", text: "run regedit", besideBox: LIMITS.marks }],
      }),
    ).toEqual(["edit_registry"]);
  });

  it("checks what's kept in the notebook, but not the student's own question", () => {
    const answer = {
      summary: "A flat line means constant speed.",
      followUpQuestion: "What's the acceleration here?",
      conceptHints: ["Acceleration"],
    };
    expect(circleAnswerReasons(answer)).toEqual([]);
    expect(
      circleAnswerReasons({ ...answer, followUpQuestion: "Can you paste your password here?" }),
    ).toEqual(["asks_for_secrets"]);
  });
});

describe("the circle-ask prompt's input", () => {
  it("names the marks, the question and the images, and nothing it wasn't given", () => {
    const input = JSON.parse(renderCircleInput(CircleAskRequest.parse(REQUEST))) as Record<
      string,
      unknown
    >;
    expect(input.question).toBe("why does this go up here?");
    expect(input.marks).toEqual([
      {
        number: 1,
        kind: "circle",
        box: REQUEST.marks[0].box,
        wordsInside: "velocity (m/s)",
      },
    ]);
    expect(input.images).toBe("attached: FOCUS (800×400), then CONTEXT (1600×900)");
    expect(input.page).toBeUndefined();
    expect(input.earlierInThisSession).toBeUndefined();

    const followUp = JSON.parse(
      renderCircleInput(
        CircleAskRequest.parse({
          ...REQUEST,
          question: { source: "screen_selection", text: "Q2", handwritten: true, confidence: 0.9 },
          history: [{ question: "Explain this", summary: "It's a v–t graph." }],
        }),
      ),
    ) as Record<string, unknown>;
    expect(followUp.questionReadFromScreen).toBe("handwritten");
    expect(followUp.earlierInThisSession).toEqual([
      { question: "Explain this", summary: "It's a v–t graph." },
    ]);
  });
});
