import { describe, expect, it } from "vitest";

import {
  addDays,
  chapterProgress,
  type ConceptProgress,
  type ConceptStatus,
  conceptStatus,
  daysBetween,
  type Evidence,
  planExam,
  progressFor,
  quizQueue,
} from "./learner";

const NOW = new Date("2026-10-18T12:00:00Z");
const LATER = new Date("2026-10-25T12:00:00Z");
const EARLIER = new Date("2026-10-17T12:00:00Z");

const a = (correct: boolean, evidence: Evidence = "independent") => ({ correct, evidence });

describe("conceptStatus", () => {
  const status = (
    attempts: ReturnType<typeof a>[],
    { explored = attempts.length > 0, due = LATER }: { explored?: boolean; due?: Date | null } = {},
  ) => conceptStatus({ attempts, explored, due, now: NOW });

  it("starts as not started, then explored once the lesson is opened", () => {
    expect(status([], { explored: false, due: null })).toBe("not_started");
    // Opening a lesson creates a card due now; that alone isn't something to revisit.
    expect(status([], { explored: true, due: NOW })).toBe("explored");
  });

  it("stays explored until the student gets one right without being shown", () => {
    expect(status([a(false)])).toBe("explored");
    expect(status([a(true, "after_explanation")])).toBe("explored");
  });

  it("only counts as checked when the latest answer was correct without help", () => {
    expect(status([a(true)])).toBe("checked");
    expect(status([a(true, "with_hint")])).toBe("practised_with_hint");
    expect(status([a(true), a(true, "with_hint")])).toBe("practised_with_hint");
    expect(status([a(false), a(true, "with_hint"), a(true)])).toBe("checked");
  });

  it("asks to revisit after a slip, or when the review comes due", () => {
    expect(status([a(true), a(false)])).toBe("revisit");
    expect(status([a(true), a(true, "after_explanation")])).toBe("revisit");
    expect(status([a(true)], { due: EARLIER })).toBe("revisit");
    expect(status([a(true, "with_hint")], { due: NOW })).toBe("revisit");
  });
});

// ─── Queue and plan ─────────────────────────────────────────────────────────────────────────

const IDS = ["c1", "c2", "c3", "c4", "c5", "c6"];

function progress(entries: Record<string, [ConceptStatus, string | null]>) {
  const known: ConceptProgress[] = Object.entries(entries).map(([id, [status, due]]) => ({
    conceptId: id,
    status,
    due,
    attempts: 1,
    independent: 0,
    lastAttemptAt: null,
  }));
  return progressFor(IDS, known);
}

describe("chapterProgress (K1 §2.2: progress on chapter cards)", () => {
  const ids = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const started = (n: number, status: ConceptStatus): ConceptProgress => ({
    conceptId: ids(n),
    status,
    due: null,
    attempts: 1,
    independent: status === "checked" ? 1 : 0,
    lastAttemptAt: null,
  });
  const progress = {
    concepts: [started(1, "checked"), started(2, "explored"), started(3, "checked")],
    conceptNodes: [
      { conceptId: ids(1), nodeId: "chapter-1" },
      { conceptId: ids(2), nodeId: "chapter-1" },
      { conceptId: ids(2), nodeId: "section-1.1" },
      { conceptId: ids(3), nodeId: "chapter-2" },
      { conceptId: ids(4), nodeId: "chapter-2" },
    ],
  };

  it("counts each of the chapter's topics once, its sections' too, and the checked ones", () => {
    expect(chapterProgress(new Set(["chapter-1", "section-1.1"]), progress)).toEqual({
      checked: 1,
      total: 2,
    });
    // A topic never started counts as not checked.
    expect(chapterProgress(new Set(["chapter-2"]), progress)).toEqual({ checked: 1, total: 2 });
  });

  it("is null for a chapter with no topics of its own", () => {
    expect(chapterProgress(new Set(["chapter-3"]), progress)).toBeNull();
  });
});

describe("progressFor", () => {
  it("fills in concepts never started", () => {
    const map = progressFor(
      ["x", "y"],
      [
        {
          conceptId: "y",
          status: "checked",
          due: null,
          attempts: 2,
          independent: 1,
          lastAttemptAt: null,
        },
      ],
    );
    expect(map.get("x")?.status).toBe("not_started");
    expect(map.get("y")?.status).toBe("checked");
  });
});

describe("quizQueue", () => {
  const map = progress({
    c1: ["checked", "2026-10-30T00:00:00Z"],
    c2: ["revisit", "2026-10-17T00:00:00Z"],
    c3: ["explored", "2026-10-18T00:00:00Z"],
    c4: ["revisit", "2026-10-10T00:00:00Z"],
    c5: ["checked", "2026-10-20T00:00:00Z"],
  });

  it("puts overdue revisits first, then unfinished, new, and finally checked concepts", () => {
    expect(quizQueue(IDS, map)).toEqual(["c4", "c2", "c3", "c6", "c5", "c1"]);
  });

  it("leads with today's planned concepts", () => {
    expect(quizQueue(IDS, map, ["c1", "c6"])).toEqual(["c6", "c1", "c4", "c2", "c3", "c5"]);
  });
});

describe("planExam", () => {
  const today = "2026-10-18";

  it("spreads unchecked work over the days left, revisits first, and keeps the eve for review", () => {
    const map = progress({
      c1: ["checked", "2026-10-19T09:00:00Z"],
      c2: ["practised_with_hint", "2026-10-19T00:00:00Z"],
      c5: ["revisit", "2026-10-17T00:00:00Z"],
      c6: ["checked", "2026-12-01T00:00:00Z"],
    });
    const plan = planExam({ orderedIds: IDS, progress: map, examDate: "2026-10-22", today });

    expect(plan.daysLeft).toBe(4);
    expect(plan.days.map((d) => d.date)).toEqual([
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
    ]);
    // Four concepts need work over three learning days: revisit first, then course order.
    expect(plan.days.map((d) => d.learn)).toEqual([["c5", "c2"], ["c3", "c4"], [], []]);
    expect(plan.days.at(-1)?.finalReview).toBe(true);
    // c1's review is due before the exam; c6's isn't.
    expect(plan.days.flatMap((d) => d.review)).toEqual(["c1"]);
  });

  it("puts everything on today when the exam is tomorrow or today, and nothing once it's passed", () => {
    const map = progress({});
    for (const examDate of ["2026-10-19", today]) {
      const plan = planExam({ orderedIds: IDS, progress: map, examDate, today });
      expect(plan.days).toHaveLength(1);
      expect(plan.days[0]?.learn).toEqual(IDS);
      expect(plan.days[0]?.finalReview).toBe(false);
    }
    expect(planExam({ orderedIds: IDS, progress: map, examDate: "2026-10-01", today })).toEqual({
      daysLeft: -17,
      days: [],
    });
  });

  it("pulls overdue reviews of checked concepts onto today", () => {
    const map = progress({ c1: ["checked", "2026-10-02T00:00:00Z"] });
    const plan = planExam({ orderedIds: ["c1"], progress: map, examDate: "2026-10-28", today });
    expect(plan.days[0]?.review).toEqual(["c1"]);
    expect(plan.days.flatMap((d) => d.learn)).toEqual([]);
  });

  it("counts calendar days across a DST change", () => {
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });
});
