import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

const ALICE = "user_alice";
const BOB = "user_bob";
const CARD = JSON.stringify({ due: "2026-10-20T00:00:00Z", stability: 3.1, reps: 1, state: 2 });

let db: Db;
let course: string;
let otherCourse: string;
let concept: string;
let bobCourse: string;
let bobConcept: string;

async function one<T>(query: Promise<{ rows: T[] }>): Promise<T> {
  const row = (await query).rows[0];
  if (row === undefined) throw new Error("expected a row");
  return row;
}

async function makeCourse(title: string): Promise<{ course: string; concept: string }> {
  const c = await one(
    db.query<{ id: string }>("insert into courses (title) values ($1) returning id", [title]),
  );
  const k = await one(
    db.query<{ id: string }>(
      `insert into concepts (course_id, title, order_index) values ($1, 'Forces', 0) returning id`,
      [c.id],
    ),
  );
  return { course: c.id, concept: k.id };
}

const insertAttempt = (courseId: string, conceptId: string, evidence = "independent") =>
  db.query(
    `insert into attempts (course_id, concept_id, correct, evidence, source)
     values ($1, $2, true, $3, 'quiz')`,
    [courseId, conceptId, evidence],
  );

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
  await db.as(BOB, () => db.query("insert into profiles default values"));
  await db.as(ALICE, async () => {
    ({ course, concept } = await makeCourse("Mechanics"));
    otherCourse = (await makeCourse("Optics")).course;
  });
  await db.as(BOB, async () => {
    ({ course: bobCourse, concept: bobConcept } = await makeCourse("Bob's course"));
  });
});

describe("learner RLS", () => {
  it("lets the owner log attempts and keep a review card per concept", async () => {
    await db.as(ALICE, async () => {
      await insertAttempt(course, concept);
      await insertAttempt(course, concept, "with_hint");
      await db.query(
        `insert into review_cards (course_id, concept_id, fsrs_state, due_at)
         values ($1, $2, $3, '2026-10-20')`,
        [course, concept, CARD],
      );
      await db.query("update review_cards set due_at = '2026-10-25' where concept_id = $1", [
        concept,
      ]);
      const { rows } = await db.query<{ user_id: string }>("select user_id from attempts");
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.user_id === ALICE)).toBe(true);
      // One card per concept.
      await expect(
        db.query(
          `insert into review_cards (course_id, concept_id, fsrs_state, due_at)
           values ($1, $2, $3, now())`,
          [course, concept, CARD],
        ),
      ).rejects.toThrow(/unique|duplicate/);
    });
  });

  it("hides one user's attempts and cards from everyone else", async () => {
    await db.as(BOB, async () => {
      for (const table of ["attempts", "review_cards"]) {
        expect((await db.query(`select * from ${table}`)).rows, table).toEqual([]);
      }
      // Updates and deletes of someone else's rows touch nothing.
      const updated = await db.query("update review_cards set due_at = now() returning id");
      expect(updated.rows).toEqual([]);
      const deleted = await db.query("delete from attempts returning id");
      expect(deleted.rows).toEqual([]);
    });
    await db.as(null, async () => {
      await expect(db.query("select * from attempts")).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from review_cards")).rejects.toThrow(/permission denied/);
    });
    const left = await db.as(ALICE, () => db.query("select id from attempts"));
    expect(left.rows).toHaveLength(2);
  });

  it("refuses attempts and cards for someone else's concept, or a mismatched course", async () => {
    await db.as(BOB, async () => {
      await expect(insertAttempt(course, concept)).rejects.toThrow(/foreign key|violates/);
      // His own course id with Alice's concept: still no.
      await expect(insertAttempt(bobCourse, concept)).rejects.toThrow(/foreign key|violates/);
      await expect(
        db.query(
          `insert into review_cards (course_id, concept_id, fsrs_state, due_at)
           values ($1, $2, $3, now())`,
          [course, concept, CARD],
        ),
      ).rejects.toThrow(/foreign key|violates/);
      // Spoofing the owner column is caught by the column grants.
      await expect(
        db.query(
          `insert into attempts (user_id, course_id, concept_id, correct, evidence, source)
           values ($1, $2, $3, true, 'independent', 'quiz')`,
          [ALICE, course, concept],
        ),
      ).rejects.toThrow(/permission denied/);
    });
    await db.as(ALICE, async () => {
      // A concept paired with the wrong course of the same user.
      await expect(insertAttempt(otherCourse, concept)).rejects.toThrow(/foreign key|violates/);
      // Bob's concept from Alice.
      await expect(insertAttempt(bobCourse, bobConcept)).rejects.toThrow(/foreign key|violates/);
    });
  });

  it("keeps attempts append-only and only lets cards change their schedule", async () => {
    await db.as(ALICE, async () => {
      await expect(db.query("update attempts set correct = false")).rejects.toThrow(
        /permission denied/,
      );
      // Backdating an attempt (or choosing its id) isn't possible either.
      await expect(
        db.query(
          `insert into attempts (course_id, concept_id, correct, evidence, source, created_at)
           values ($1, $2, true, 'independent', 'quiz', '2020-01-01')`,
          [course, concept],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query("update review_cards set concept_id = gen_random_uuid()"),
      ).rejects.toThrow(/permission denied/);
      await expect(insertAttempt(course, concept, "guessed")).rejects.toThrow(/check/);
      await expect(
        db.query("update review_cards set fsrs_state = $1", [
          JSON.stringify({ blob: "x".repeat(4000) }),
        ]),
      ).rejects.toThrow(/check/);
      await expect(
        db.query("update review_cards set fsrs_state = '[1, 2]'::jsonb"),
      ).rejects.toThrow(/check/);
    });
  });

  it("deletes a course's attempts and cards with the course", async () => {
    await db.as(ALICE, async () => {
      await db.query("delete from courses where id = $1", [course]);
      expect((await db.query("select * from attempts")).rows).toEqual([]);
      expect((await db.query("select * from review_cards")).rows).toEqual([]);
    });
  });
});
