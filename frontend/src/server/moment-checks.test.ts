import type { MathCheckResponse } from "@mew/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { path: string; options?: { method?: string; body?: unknown } }[] = [];
let check: Record<string, unknown> = {};

const NODE = "33333333-3333-4333-8333-333333333333";
const NOTEBOOK = "44444444-4444-4444-8444-444444444444";
const COURSE = "55555555-5555-4555-8555-555555555555";
const CONCEPT = "66666666-6666-4666-8666-666666666666";

vi.mock("./user-api", () => ({
  userApi: vi.fn(
    (path: string, _schema: unknown, options?: { method?: string; body?: unknown }) => {
      calls.push({ path, ...(options && { options }) });
      if (path === "/v1/notebooks/tree") {
        return Promise.resolve({
          nodes: [
            { id: NOTEBOOK, parentId: null, courseId: COURSE },
            { id: NODE, parentId: NOTEBOOK, courseId: null },
          ],
        });
      }
      if (options?.method === "PATCH") return Promise.resolve(undefined);
      return Promise.resolve(check);
    },
  ),
}));
vi.mock("./courses", () => ({
  coursesApi: vi.fn(() =>
    Promise.resolve({
      concepts: [
        { id: CONCEPT, title: "Acceleration" },
        { id: "77777777-7777-4777-8777-777777777777", title: "Momentum" },
      ],
    }),
  ),
}));

import { answerCheck, type MomentCheckDeps } from "./moment-checks";

function deps(verdict: "correct" | "incorrect" = "correct", sympy = true) {
  const record = vi.fn(() => Promise.resolve({}) as never);
  const grade = vi.fn(() => Promise.resolve({ verdict, feedback: "Graded.", note: "" }));
  const checkMath = vi.fn((steps: string[]) =>
    Promise.resolve(
      sympy
        ? steps.map((_, index): MathCheckResponse["results"][number] => ({
            index,
            verdict: index === 0 ? "unknown" : steps[1] === "x = 3" ? "correct" : "incorrect",
            reason: "checked",
          }))
        : null,
    ),
  );
  return {
    record,
    grade,
    checkMath,
    deps: {
      record,
      grade,
      checkMath,
      now: () => new Date("2026-10-26T12:00:00Z"),
    } as unknown as MomentCheckDeps,
  };
}

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  clipId: "22222222-2222-4222-8222-222222222222",
  nodeId: NODE,
  prompt: "Solve 2x = 6.",
  kind: "work",
  choices: [],
  conceptHints: ["acceleration"],
  isNew: true,
  dueAt: "2026-10-26T00:00:00+00:00",
  createdAt: "2026-10-25T10:00:00+00:00",
  answerKey: "x = 3",
  answerLatex: "x = 3",
  fsrsState: null,
  reps: 0,
};

beforeEach(() => {
  calls.length = 0;
  check = { ...base };
});

describe("answering a moment's check (K8 §4.7)", () => {
  it("checks maths by SymPy, reschedules the card and logs independent evidence", async () => {
    const { deps: d, record, grade } = deps();
    const result = await answerCheck(base.id, { answer: "3", peeked: false, hinted: false }, d);

    expect(result).toMatchObject({ correct: true, evidence: "independent", answerKey: "x = 3" });
    expect(grade).not.toHaveBeenCalled(); // SymPy settled it ("3" means "x = 3")
    const patch = calls.find((c) => c.options?.method === "PATCH");
    expect(patch?.path).toBe(`/v1/moments/checks/${base.id}`);
    expect(patch?.options?.body).toMatchObject({ reps: 1 });
    // Good on the first go: due again in a few days, not tomorrow.
    expect(Date.parse(result.nextDue)).toBeGreaterThan(Date.parse("2026-10-28T00:00:00Z"));
    // Evidence for the matching concept of the notebook's course only.
    expect(record).toHaveBeenCalledWith(COURSE, {
      conceptId: CONCEPT,
      correct: true,
      evidence: "independent",
      source: "moment_check",
    });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("marks a check stayed when it's right, alone, a day after it was saved (U6)", async () => {
    const result = await answerCheck(
      base.id,
      { answer: "3", peeked: false, hinted: false },
      deps().deps,
    );
    expect(result.stayed).toBe(true); // saved the 25th at 10:00, answered the 26th at 12:00
    const patch = calls.find((c) => c.options?.method === "PATCH");
    expect(patch?.options?.body).toMatchObject({ stayed: true });

    calls.length = 0;
    check = { ...base, createdAt: "2026-10-26T09:00:00+00:00" };
    const soon = await answerCheck(
      base.id,
      { answer: "3", peeked: false, hinted: false },
      deps().deps,
    );
    expect(soon.stayed).toBe(false);
    const quiet = calls.find((c) => c.options?.method === "PATCH");
    expect(quiet?.options?.body).not.toHaveProperty("stayed");
  });

  it("“I don't know yet” isn't graded and brings the card back sooner (U6)", async () => {
    const { deps: d, grade, checkMath } = deps();
    const result = await answerCheck(
      base.id,
      { answer: "I don't know yet", peeked: false, hinted: false, dontKnow: true },
      d,
    );
    expect(grade).not.toHaveBeenCalled();
    expect(checkMath).not.toHaveBeenCalled();
    expect(result).toMatchObject({ correct: false, evidence: null, stayed: false });
    expect(Date.parse(result.nextDue) - Date.parse("2026-10-26T12:00:00Z")).toBeLessThanOrEqual(
      86_400_000,
    );
  });

  it("counts a peek as a hint, and a wrong answer brings the card back tomorrow", async () => {
    const peeked = await answerCheck(
      base.id,
      { answer: "x = 3", peeked: true, hinted: false },
      deps().deps,
    );
    expect(peeked.evidence).toBe("with_hint");

    const { deps: d, record } = deps();
    const wrong = await answerCheck(base.id, { answer: "x = 4", peeked: false, hinted: false }, d);
    expect(wrong).toMatchObject({ correct: false, evidence: null });
    expect(Date.parse(wrong.nextDue) - Date.parse("2026-10-26T12:00:00Z")).toBeLessThanOrEqual(
      86_400_000,
    );
    expect(record).toHaveBeenCalledWith(COURSE, expect.objectContaining({ correct: false }));
  });

  it("grades words with the grader, and a multiple choice by its choice", async () => {
    check = { ...base, kind: "short", answerLatex: null, answerKey: "Velocity changes." };
    const { deps: d, grade } = deps("correct");
    const said = await answerCheck(
      base.id,
      { answer: "the speed changes", peeked: false, hinted: false },
      d,
    );
    expect(grade).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "Solve 2x = 6.",
        expected: "Velocity changes.",
        spoken: "the speed changes",
      }),
    );
    expect(said.correct).toBe(true);

    check = { ...base, kind: "mcq", choices: ["Up", "Down"], answerKey: "Down", answerLatex: null };
    const picked = await answerCheck(
      base.id,
      { answer: "down", peeked: false, hinted: false },
      deps().deps,
    );
    expect(picked.correct).toBe(true);
  });

  it("logs nothing for a moment with no course", async () => {
    check = { ...base, nodeId: null };
    const { deps: d, record } = deps();
    await answerCheck(base.id, { answer: "3", peeked: false, hinted: false }, d);
    expect(record).not.toHaveBeenCalled();
  });
});
