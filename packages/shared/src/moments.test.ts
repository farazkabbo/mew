import { describe, expect, it } from "vitest";
import { z } from "zod";

import { sourceKey } from "./destinations";
import {
  checkEvidence,
  type MomentCheckView,
  pickQuickCheck,
  savedQuizRequest,
  unsortedNodeId,
} from "./moments";
import { suggestSubject } from "./notebook-tree";
import sourceCases from "./source-key.cases.json";
import unsortedCases from "./unsorted-id.cases.json";

describe("the Unsorted notebook's id", () => {
  it.each(unsortedCases)("is the same everywhere for $userId", ({ userId, id }) => {
    expect(unsortedNodeId(userId)).toBe(id);
    expect(z.uuid().safeParse(id).success).toBe(true);
  });

  it("is different for every student", () => {
    expect(new Set(unsortedCases.map((c) => c.id)).size).toBe(unsortedCases.length);
  });
});

describe("sourceKey (mirrored in Python: moments/source.py)", () => {
  it.each(sourceCases)("%j", ({ source, key }) => {
    expect(sourceKey(source)).toBe(key);
  });
});

describe("quiz me on what I saved", () => {
  it.each([
    ["quiz me on what I saved today", { since: "today", place: null }],
    ["Quiz me on what I've saved this week", { since: "week", place: null }],
    ["test me on everything I saved in physics", { since: null, place: "physics" }],
    [
      "neb, quiz me on what I saved in my chemistry notebook today",
      { since: "today", place: "chemistry" },
    ],
    ["quiz me on what I saved", { since: null, place: null }],
  ])("%s", (utterance, filter) => {
    expect(savedQuizRequest(utterance)).toEqual(filter);
  });

  it.each(["quiz me", "what did I save?", "save this to physics"])("not %s", (utterance) => {
    expect(savedQuizRequest(utterance)).toBeNull();
  });
});

describe("what a check's answer counts as", () => {
  it("is mastery only when correct with no peek and no hint", () => {
    expect(checkEvidence({ correct: true, peeked: false, hinted: false })).toBe("independent");
    expect(checkEvidence({ correct: true, peeked: true, hinted: false })).toBe("with_hint");
    expect(checkEvidence({ correct: true, peeked: false, hinted: true })).toBe("with_hint");
    expect(checkEvidence({ correct: false, peeked: false, hinted: false })).toBeNull();
  });
});

describe("a Quick check", () => {
  const NOW = Date.parse("2026-10-26T12:00:00Z");
  const check = (
    n: number,
    createdDaysAgo: number,
    dueInDays: number,
    nodeId: string | null = null,
  ) =>
    ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      clipId: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      nodeId,
      prompt: `Question ${n}`,
      kind: "short",
      choices: [],
      conceptHints: [],
      isNew: true,
      dueAt: new Date(NOW + dueInDays * 86_400_000).toISOString(),
      createdAt: new Date(NOW - createdDaysAgo * 86_400_000).toISOString(),
    }) satisfies MomentCheckView;

  it("asks 3–5 due questions, mostly from recent moments", () => {
    const due = [
      check(1, 1, -1),
      check(2, 9, -8),
      check(3, 2, -1),
      check(4, 20, -15),
      check(5, 3, 0),
      check(6, 4, -2),
      check(7, 1, 3),
    ];
    const picked = pickQuickCheck(due, { now: NOW });
    expect(picked).toHaveLength(5);
    expect(picked.map((c) => c.prompt).slice(0, 3)).toEqual([
      "Question 1",
      "Question 3",
      "Question 5",
    ]);
    expect(picked.map((c) => c.prompt)).not.toContain("Question 7"); // not due yet
  });

  it("can be about today's moments, or one notebook's, even before they're due", () => {
    const all = [check(1, 0, 1, "aaaaaaaa-0000-4000-8000-000000000000"), check(2, 3, -1)];
    expect(pickQuickCheck(all, { now: NOW, since: "today" }).map((c) => c.prompt)).toEqual([
      "Question 1",
    ]);
    const physics = new Set(["aaaaaaaa-0000-4000-8000-000000000000"]);
    expect(pickQuickCheck(all, { now: NOW, nodeIds: physics })).toEqual([]); // not due yet
    expect(pickQuickCheck(all, { now: NOW, since: "week", nodeIds: physics })).toHaveLength(1);
  });
});

describe("a notebook's subject, from its name", () => {
  it.each([
    ["Physics", "physics"],
    ["Organic Chemistry", "chemistry"],
    ["Calculus II", "math"],
    ["Biology 101", "biology"],
    ["CS 50", "programming"],
    ["Modern History", "history"],
    ["Spanish", "language"],
    ["Diary", null],
  ])("%s → %s", (name, subject) => {
    expect(suggestSubject(name)).toBe(subject);
  });
});
