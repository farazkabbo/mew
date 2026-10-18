import type { AttemptRecord, Evidence, FsrsCard, LearnerData } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { newCard, progressOf, review } from "./learner";

const NOW = new Date("2026-10-18T12:00:00Z");
const DAY = 86_400_000;
const days = (card: FsrsCard, from = NOW) =>
  Math.round((Date.parse(card.due) - from.getTime()) / DAY);

const answer = (correct: boolean, evidence: Evidence = "independent") => ({ correct, evidence });

describe("FSRS scheduling", () => {
  it("brings a concept back sooner the more help an answer needed", () => {
    const independent = review(null, answer(true), NOW);
    const hinted = review(null, answer(true, "with_hint"), NOW);
    const shown = review(null, answer(true, "after_explanation"), NOW);
    const wrong = review(null, answer(false), NOW);
    expect(days(independent)).toBe(3);
    expect(days(hinted)).toBe(2);
    expect(days(shown)).toBe(1);
    expect(days(wrong)).toBe(1);
    // No minute-level learning steps: concepts aren't flashcards.
    expect(independent.scheduled_days).toBeGreaterThanOrEqual(1);
  });

  it("only grows memory meaningfully from independent answers", () => {
    let independent = review(null, answer(true), NOW);
    let hinted = review(null, answer(true, "with_hint"), NOW);
    for (let i = 0; i < 3; i++) {
      independent = review(independent, answer(true), new Date(independent.due));
      hinted = review(hinted, answer(true, "with_hint"), new Date(hinted.due));
    }
    expect(independent.stability).toBeGreaterThan(hinted.stability * 2);
    expect(days(independent)).toBeGreaterThan(30);
  });

  it("round-trips a stored card, and a slip after learning counts as a lapse", () => {
    const learned = review(
      review(null, answer(true), NOW),
      answer(true),
      new Date(NOW.getTime() + 3 * DAY),
    );
    const stored = JSON.parse(JSON.stringify(learned)) as FsrsCard;
    const slipped = review(stored, answer(false), new Date(learned.due));
    expect(slipped.lapses).toBe(1);
    expect(slipped.reps).toBe(3);
    expect(newCard(NOW)).toMatchObject({ due: NOW.toISOString(), reps: 0, last_review: null });
  });
});

describe("progressOf", () => {
  const attempt = (
    concept: string,
    correct: boolean,
    evidence: Evidence,
    at: string,
  ): AttemptRecord => ({
    concept_id: concept,
    correct,
    evidence,
    source: "quiz",
    created_at: at,
  });
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";

  it("derives each started concept's status, next review and counts", () => {
    const later = review(null, answer(true), NOW);
    const data: LearnerData = {
      attempts: [
        attempt(A, false, "independent", "2026-10-17T10:00:00Z"),
        attempt(A, true, "with_hint", "2026-10-17T10:05:00Z"),
        attempt(A, true, "independent", "2026-10-18T11:00:00Z"),
      ],
      cards: [
        { concept_id: A, fsrs_state: later, due_at: later.due },
        { concept_id: B, fsrs_state: newCard(NOW), due_at: NOW.toISOString() },
      ],
    };
    const progress = new Map(progressOf(data, NOW).map((p) => [p.conceptId, p]));
    expect(progress.get(A)).toMatchObject({
      status: "checked",
      attempts: 3,
      independent: 1,
      due: later.due,
      lastAttemptAt: "2026-10-18T11:00:00Z",
    });
    expect(progress.get(B)).toMatchObject({ status: "explored", attempts: 0 });
    // Three days on, the checked concept is due again.
    const afterwards = progressOf(data, new Date(NOW.getTime() + 4 * DAY));
    expect(afterwards.find((p) => p.conceptId === A)?.status).toBe("revisit");
  });
});
