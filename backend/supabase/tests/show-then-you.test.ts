import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

const ALICE = "user_alice";

let db: Db;
let course: string;
let concept: string;

async function one<T>(query: Promise<{ rows: T[] }>): Promise<T> {
  const row = (await query).rows[0];
  if (row === undefined) throw new Error("expected a row");
  return row;
}

const attempt = (source: string, evidence = "independent") =>
  db.as(ALICE, () =>
    db.query(
      `insert into attempts (course_id, concept_id, correct, evidence, source)
       values ($1, $2, true, $3, $4)`,
      [course, concept, evidence, source],
    ),
  );

const setSettings = (settings: object) =>
  db.as(ALICE, () =>
    db.query("update profiles set settings = $1 where id = $2", [JSON.stringify(settings), ALICE]),
  );

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, async () => {
    await db.query("insert into profiles default values");
    course = (
      await one(
        db.query<{ id: string }>("insert into courses (title) values ('Algebra') returning id"),
      )
    ).id;
    concept = (
      await one(
        db.query<{ id: string }>(
          `insert into concepts (course_id, title, order_index)
           values ($1, 'Linear equations', 0) returning id`,
          [course],
        ),
      )
    ).id;
  });
});

describe("Show-then-You (K6)", () => {
  it("logs a Your Turn as an attempt of its own, solved alone or with a hint", async () => {
    await attempt("your_turn");
    await attempt("your_turn", "with_hint");
    const { rows } = await db.as(ALICE, () =>
      db.query<{ evidence: string }>(
        "select evidence from attempts where source = 'your_turn' order by evidence",
      ),
    );
    expect(rows.map((r) => r.evidence)).toEqual(["independent", "with_hint"]);
  });

  it("still refuses sources it doesn't know", async () => {
    await expect(attempt("your_turns")).rejects.toThrow(/check constraint/);
  });

  it("keeps the Your Turn setting a boolean", async () => {
    await setSettings({ your_turn_after_solution: false });
    await setSettings({ your_turn_after_solution: true });
    await expect(setSettings({ your_turn_after_solution: "no" })).rejects.toThrow(
      /check constraint/,
    );
  });
});
