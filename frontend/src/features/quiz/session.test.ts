import type { Line, PageDocument } from "@mew/ink";
import type {
  AttemptRequest,
  BoardAction,
  ConceptProgress,
  CourseDetail,
  Lesson,
  QuizGrade,
  QuizGradeRequest,
} from "@mew/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type QuizDeps, QuizSession } from "./session";
import { INITIAL_QUIZ, useQuiz } from "./store";

const COURSE = "22222222-2222-4222-8222-222222222222";
const FORCES = "11111111-1111-4111-8111-111111111111";
const FRICTION = "33333333-3333-4333-8333-333333333333";

const DETAIL: CourseDetail = {
  course: {
    id: COURSE,
    title: "Mechanics",
    status: "ready",
    created_at: "2026-10-01T00:00:00Z",
  },
  sources: [],
  concepts: [
    {
      id: FORCES,
      course_id: COURSE,
      title: "Forces",
      summary: "A force is a push or a pull.",
      order_index: 0,
      source_pages: [1],
    },
    {
      id: FRICTION,
      course_id: COURSE,
      title: "Friction",
      summary: "Friction opposes sliding.",
      order_index: 1,
      source_pages: [3],
    },
  ],
  edges: [],
};

const LESSON: Lesson = {
  explanation: "…",
  worked_example: "",
  practice: [
    {
      question: "Which way does friction act?",
      answer: "Against the motion.",
      hint: "Think of brakes.",
    },
  ],
  pages: [3],
  generated: true,
};

const line = (id: string, at: number): Line => ({
  id,
  strokeIds: [id],
  bbox: [0, at, 100, 20],
  firstCreatedAt: at,
  lastCreatedAt: at,
});

type Fake = {
  deps: QuizDeps;
  attempts: AttemptRequest[];
  grades: QuizGradeRequest[];
  marks: BoardAction[][];
  said: string[];
  lines: Line[];
  setNow(at: number): void;
  setGrade(grade: QuizGrade | null): void;
};

function fake({ friction = "revisit" as ConceptProgress["status"], lesson = LESSON } = {}): Fake {
  let now = 1000;
  let grade: QuizGrade | null = { verdict: "correct", feedback: "Yes.", note: "" };
  const state = {
    attempts: [] as AttemptRequest[],
    grades: [] as QuizGradeRequest[],
    marks: [] as BoardAction[][],
    said: [] as string[],
    lines: [] as Line[],
  };
  const deps: QuizDeps = {
    api: {
      detail: () => Promise.resolve(DETAIL),
      progress: () =>
        Promise.resolve({
          concepts: [
            {
              conceptId: FRICTION,
              status: friction,
              due: "2026-10-01T00:00:00Z",
              attempts: 2,
              independent: 1,
              lastAttemptAt: null,
            },
          ],
        }),
      lesson: (_, conceptId) =>
        conceptId === FRICTION ? Promise.resolve(lesson) : Promise.reject(new Error("offline")),
      attempt: (_, attempt) => {
        state.attempts.push(attempt);
        return Promise.resolve({
          conceptId: attempt.conceptId,
          status: attempt.correct ? "checked" : "revisit",
          due: null,
          attempts: 1,
          independent: 0,
          lastAttemptAt: null,
        });
      },
    },
    grade: (request) => {
      state.grades.push(request);
      return Promise.resolve(grade);
    },
    doc: () => ({}) as PageDocument,
    lines: () => state.lines,
    recognize: (_, l) => Promise.resolve(`text of ${l.id}`),
    renderAnswer: (_, lines) => Promise.resolve(lines.length ? "iVBORw0KGgo=" : null),
    spokenSince: () => "",
    mark: (actions) => state.marks.push(actions),
    say: (text) => {
      state.said.push(text);
      return Promise.resolve();
    },
    now: () => now,
  };
  return {
    deps,
    ...state,
    setNow: (at) => {
      now = at;
    },
    setGrade: (next) => {
      grade = next;
    },
  };
}

beforeEach(() => {
  useQuiz.setState(INITIAL_QUIZ);
  vi.restoreAllMocks();
});

describe("QuizSession", () => {
  it("asks the concept that needs revisiting first, from its lesson, out loud", async () => {
    const f = fake();
    const quiz = new QuizSession(f.deps);
    await quiz.start(COURSE);

    const state = useQuiz.getState();
    expect(state).toMatchObject({ active: true, phase: "asking", courseTitle: "Mechanics" });
    expect(state.question).toMatchObject({ conceptId: FRICTION, fromLesson: true });
    expect(f.said).toEqual(["Which way does friction act?"]);
    // The tutor gets the question, never the model answer.
    expect(quiz.context()).toEqual({
      concept: "Friction",
      question: "Which way does friction act?",
    });
  });

  it("grades only what was written after the question, ticks it and records an independent answer", async () => {
    const f = fake();
    f.lines.push(line("line_old", 500)); // earlier work on the page
    const quiz = new QuizSession(f.deps);
    await quiz.start(COURSE);
    f.lines.push(line("line_answer", 2000));

    await quiz.check();

    expect(f.grades[0]).toMatchObject({
      question: "Which way does friction act?",
      expected: "Against the motion.",
      recognized: ["text of line_answer"],
      image: "iVBORw0KGgo=",
    });
    expect(f.marks).toEqual([[{ type: "mark_correct", targetLineId: "line_answer" }]]);
    expect(f.attempts).toEqual([
      { conceptId: FRICTION, correct: true, evidence: "independent", source: "quiz" },
    ]);
    expect(useQuiz.getState()).toMatchObject({
      phase: "done",
      status: "checked",
      asked: 1,
      correct: 1,
    });
  });

  it("counts a hint, help from the tutor, or a wrong first try as 'with hint'", async () => {
    for (const help of ["hint", "tutor", "wrong try"] as const) {
      useQuiz.setState(INITIAL_QUIZ);
      const f = fake();
      const quiz = new QuizSession(f.deps);
      await quiz.start(COURSE);
      f.lines.push(line("line_a", 2000));
      if (help === "hint") quiz.hint();
      if (help === "tutor") quiz.helpedByTutor();
      if (help === "wrong try") {
        f.setGrade({
          verdict: "incorrect",
          feedback: "Which way is it moving?",
          note: "direction?",
        });
        await quiz.check();
        expect(f.marks.at(-1)).toEqual([
          { type: "mark_error", targetLineId: "line_a", note: "direction?" },
        ]);
        expect(useQuiz.getState().phase).toBe("asking");
        f.setGrade({ verdict: "correct", feedback: "Yes.", note: "" });
      }
      await quiz.check();
      expect(f.attempts, help).toEqual([
        { conceptId: FRICTION, correct: true, evidence: "with_hint", source: "quiz" },
      ]);
    }
  });

  it("counts a correct answer after seeing the model answer as 'after explanation'", async () => {
    const f = fake();
    const quiz = new QuizSession(f.deps);
    await quiz.start(COURSE);
    quiz.reveal();
    f.lines.push(line("line_a", 2000));
    await quiz.check();
    expect(f.attempts[0]).toMatchObject({ correct: true, evidence: "after_explanation" });
  });

  it("shows the answer and records 'not known' after three wrong tries", async () => {
    const f = fake();
    f.setGrade({ verdict: "partly", feedback: "Nearly.", note: "" });
    const quiz = new QuizSession(f.deps);
    await quiz.start(COURSE);
    f.lines.push(line("line_a", 2000));
    for (let i = 0; i < 3; i++) await quiz.check();
    expect(useQuiz.getState()).toMatchObject({ phase: "done", revealed: true });
    expect(f.attempts).toEqual([
      { conceptId: FRICTION, correct: false, evidence: "after_explanation", source: "quiz" },
    ]);
  });

  it("lets the student grade themselves when no grader is available", async () => {
    const f = fake();
    f.setGrade(null);
    const quiz = new QuizSession(f.deps);
    await quiz.start(COURSE);
    f.lines.push(line("line_a", 2000));
    await quiz.check();
    expect(useQuiz.getState().phase).toBe("self");
    await quiz.selfGrade(true);
    expect(f.marks).toEqual([[{ type: "mark_correct", targetLineId: "line_a" }]]);
    expect(f.attempts[0]).toMatchObject({ correct: true, evidence: "independent" });
  });

  it("asks for an answer before checking, and doesn't record skipped questions never tried", async () => {
    const f = fake();
    const quiz = new QuizSession(f.deps);
    await quiz.start(COURSE);
    await quiz.check();
    expect(f.grades).toEqual([]);
    expect(useQuiz.getState().message).toMatch(/Write or say your answer/);

    await quiz.next(); // skip
    expect(f.attempts).toEqual([]);
    // Next comes the other concept; its lesson failed to load, so a recall question.
    expect(useQuiz.getState().question).toMatchObject({
      conceptId: FORCES,
      fromLesson: false,
      answer: "A force is a push or a pull.",
    });
  });

  it("records a question abandoned after a wrong try as not known", async () => {
    const f = fake();
    f.setGrade({ verdict: "incorrect", feedback: "Not quite.", note: "" });
    const quiz = new QuizSession(f.deps);
    await quiz.start(COURSE);
    f.lines.push(line("line_a", 2000));
    await quiz.check();
    await quiz.stop();
    expect(f.attempts).toEqual([
      { conceptId: FRICTION, correct: false, evidence: "with_hint", source: "quiz" },
    ]);
    expect(useQuiz.getState().active).toBe(false);
  });

  it("won't quiz a course that's still being reviewed", async () => {
    const f = fake();
    f.deps.api.detail = () =>
      Promise.resolve({ ...DETAIL, course: { ...DETAIL.course, status: "review" } });
    await new QuizSession(f.deps).start(COURSE);
    expect(useQuiz.getState()).toMatchObject({ phase: "finished", question: null });
    expect(useQuiz.getState().message).toMatch(/isn't ready/);
  });
});
