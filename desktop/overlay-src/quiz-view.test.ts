import { describe, expect, it } from "vitest";

import { quizKey, quizLayout } from "./quiz-view";

const asking = {
  step: 1,
  total: 2,
  prompt: "Why is a thrown ball's path curved?",
  kind: "short",
  choices: [],
  phase: "asking",
  correct: null,
  said: null,
  last: false,
};
const key = (k: string) => ({ key: k, ctrlKey: false, altKey: false, metaKey: false });

describe("the quiz card", () => {
  it("asks a question with a box to type the answer", () => {
    const layout = quizLayout(asking);
    expect(layout).toMatchObject({ top: "Quiz · question 1 of 2", input: true, choices: [] });
    expect(layout?.buttons.map((b) => b.action)).toEqual(["stop", "next", "answer"]);
    expect(quizKey(key("Enter"), layout, true)).toEqual({ action: "answer" });
    expect(quizKey(key("Enter"), layout, false)).toBeNull();
  });

  it("offers a multiple choice's options, one tap each", () => {
    const layout = quizLayout({ ...asking, kind: "mcq", choices: ["0", "9.8 m/s²"] });
    expect(layout).toMatchObject({ choices: ["0", "9.8 m/s²"], input: false });
    expect(layout?.buttons.map((b) => b.label)).toEqual(["Stop", "Skip"]);
    expect(quizKey(key("2"), layout, false)).toEqual({ action: "answer", choice: 1 });
    expect(quizKey(key("3"), layout, false)).toBeNull();
  });

  it("shows the grade and goes on", () => {
    const answered = quizLayout({
      ...asking,
      step: 2,
      phase: "answered",
      correct: false,
      said: "Not quite. The answer: 0",
      last: true,
    });
    expect(answered?.result).toEqual({ text: "Not quite. The answer: 0", correct: false });
    expect(answered?.buttons.at(-1)).toMatchObject({ action: "next", label: "Finish" });
    expect(quizKey(key("Enter"), answered, false)).toEqual({ action: "next" });
    const checking = quizLayout({ ...asking, phase: "checking" });
    expect(checking?.busy).toBe(true);
    expect(quizKey(key("Enter"), checking, true)).toBeNull();
    expect(quizKey(key("Escape"), checking, false)).toEqual({ action: "stop" });
  });

  it("refuses what Rust would never send", () => {
    expect(quizLayout(null)).toBeNull();
    expect(quizLayout({ ...asking, step: 3 })).toBeNull();
    expect(quizLayout({ ...asking, total: 4 })).toBeNull();
    expect(quizLayout({ ...asking, prompt: "x".repeat(301) })).toBeNull();
    expect(quizLayout({ ...asking, phase: "done" })).toBeNull();
  });
});
