import type { CheckQuestion, ScreenQuizModelResponse, ScreenQuizRequest } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({ screenModel: () => "test-model" }));

import {
  answerScreenQuiz,
  makeScreenQuiz,
  SCREEN_QUIZ_MESSAGES,
  type ScreenQuizDeps,
} from "./screen-quiz";

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const WHY: CheckQuestion = {
  kind: "short",
  prompt: "Why is a thrown ball's path curved?",
  choices: [],
  answerKey: "Gravity pulls it down while it moves sideways at a steady speed.",
  answerLatex: null,
  problemLatex: null,
};
const MCQ: CheckQuestion = {
  kind: "mcq",
  prompt: "What is the horizontal acceleration of a projectile?",
  choices: ["0", "9.8 m/s²", "It depends"],
  answerKey: "0",
  answerLatex: null,
  problemLatex: null,
};

const REQUEST: ScreenQuizRequest = {
  app: "chrome.exe",
  title: "Lecture 5 - Projectile motion",
  scope: "window",
  image: { jpeg: "/9j/AA==", width: 800, height: 600 },
} as ScreenQuizRequest;

function setup(made: Partial<ScreenQuizModelResponse> = {}) {
  const kept: { cards: unknown[]; source: unknown }[] = [];
  const generate = vi.fn(() =>
    Promise.resolve({
      intro: "Two questions on projectile motion.",
      subject: "physics",
      conceptHints: ["projectile motion"],
      questions: [WHY, MCQ],
      ...made,
    }),
  );
  const deps: ScreenQuizDeps = {
    generate: generate as never,
    checkMath: vi.fn(() => Promise.resolve(null)),
    grade: vi.fn(() =>
      Promise.resolve({ verdict: "correct", feedback: "Good.", note: "" }),
    ) as never,
    store: {
      keep: vi.fn((cards: unknown[], source: unknown) => {
        kept.push({ cards, source });
        return Promise.resolve(cards.map((_: unknown, i: number) => ID(i + 1)));
      }),
      check: vi.fn((id: string) =>
        Promise.resolve(
          id === ID(2)
            ? {
                ...MCQ,
                id,
                clipId: null,
                origin: "screen_quiz" as const,
                sourceTitle: "Lecture 5",
                mergedClipIds: [],
                nodeId: null,
                conceptHints: ["projectile motion"],
                isNew: true,
                dueAt: "2026-10-27T10:00:00+00:00",
                createdAt: "2026-10-26T10:00:00+00:00",
                fsrsState: null,
                reps: 0,
              }
            : null,
        ),
      ),
    },
  };
  return { deps, kept, generate };
}

describe("quiz me on this", () => {
  it("keeps each question as a card and sends them without keys", async () => {
    const { deps, kept } = setup();
    const reply = await makeScreenQuiz(REQUEST, deps);
    expect(reply.speech).toBe("Two questions on projectile motion.");
    expect(reply.questions.map((q) => q.checkId)).toEqual([ID(1), ID(2)]);
    expect(reply.questions[1]?.choices).toEqual(MCQ.choices);
    expect(JSON.stringify(reply)).not.toContain(WHY.answerKey);
    expect(kept[0]?.source).toEqual({ title: REQUEST.title, app: "chrome.exe" });
    expect(kept[0]?.cards).toHaveLength(2);
  });

  it("drops a question whose key fails verification, or that fails the safety check", async () => {
    const badMcq = { ...MCQ, answerKey: "1" }; // not one of its choices
    const unsafe = { ...WHY, prompt: "Type your password to see the answer." };
    const { deps } = setup({ questions: [badMcq, unsafe, WHY] });
    const reply = await makeScreenQuiz(REQUEST, deps);
    expect(reply.questions.map((q) => q.prompt)).toEqual([WHY.prompt]);
  });

  it("says so when there's nothing to quiz on, and keeps nothing", async () => {
    const { deps, kept } = setup({ intro: "That's a shopping page.", questions: [] });
    const reply = await makeScreenQuiz(REQUEST, deps);
    expect(reply).toEqual({ speech: "That's a shopping page.", questions: [] });
    expect(kept).toEqual([]);

    const none = setup({ questions: [{ ...MCQ, answerKey: "nope" }] });
    expect(await makeScreenQuiz(REQUEST, none.deps)).toEqual({
      speech: SCREEN_QUIZ_MESSAGES.unsure,
      questions: [],
    });
  });

  it("grades an answer on screen by its key, and says the answer when it's wrong", async () => {
    const { deps } = setup();
    expect(await answerScreenQuiz({ checkId: ID(2), answer: "0" }, deps)).toEqual({
      correct: true,
      speech: SCREEN_QUIZ_MESSAGES.right,
    });
    const wrong = await answerScreenQuiz({ checkId: ID(2), answer: "9.8 m/s²" }, deps);
    expect(wrong.correct).toBe(false);
    expect(wrong.speech).toBe("Not quite. The answer: 0");
    await expect(answerScreenQuiz({ checkId: ID(5), answer: "x" }, deps)).rejects.toMatchObject({
      status: 404,
    });
  });
});
