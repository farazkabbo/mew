import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

/** K10: the handwriting profile (20261110000000_handwriting). */

const ALICE = "user_alice";
const BOB = "user_bob";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAG7buVgAAAABJRU5ErkJggg==";
let db: Db;

const add = (id: string, fields: Record<string, unknown> = {}) =>
  db.query(
    `insert into handwriting_samples (id, text, latex, read_as, source, image)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      fields.text ?? "x = 7",
      fields.latex ?? "x = 7",
      fields.read_as ?? "x = 1",
      fields.source ?? "fix",
      fields.image ?? PNG,
    ],
  );

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
  await db.as(BOB, () => db.query("insert into profiles default values"));
});

describe("handwriting_samples", () => {
  it("are the student's own: invisible to anyone else, and deletable", async () => {
    const id = "55555555-5555-4555-8555-000000000001";
    await db.as(ALICE, () => add(id));
    const mine = await db.as(ALICE, () =>
      db.query("select user_id, read_as from handwriting_samples"),
    );
    expect(mine.rows).toEqual([{ user_id: ALICE, read_as: "x = 1" }]);
    expect((await db.as(BOB, () => db.query("select * from handwriting_samples"))).rows).toEqual(
      [],
    );
    // Bob deletes nothing of Alice's.
    await db.as(BOB, () => db.query("delete from handwriting_samples"));
    expect(
      (await db.as(ALICE, () => db.query("select id from handwriting_samples"))).rows,
    ).toHaveLength(1);
    // Reset.
    await db.as(ALICE, () => db.query("delete from handwriting_samples"));
    expect((await db.as(ALICE, () => db.query("select id from handwriting_samples"))).rows).toEqual(
      [],
    );
  });

  it("can't be written for someone else or changed after", async () => {
    const id = "55555555-5555-4555-8555-000000000002";
    await expect(
      db.as(ALICE, () =>
        db.query(
          `insert into handwriting_samples (id, user_id, text, source, image)
           values ($1, $2, 'a', 'fix', $3)`,
          [id, BOB, PNG],
        ),
      ),
    ).rejects.toThrow();
    await db.as(ALICE, () => add(id));
    await expect(
      db.as(ALICE, () => db.query("update handwriting_samples set text = 'y' where id = $1", [id])),
    ).rejects.toThrow(/permission denied/);
  });

  it("refuse what isn't a sample", async () => {
    for (const fields of [
      { text: "" },
      { text: "x".repeat(301) },
      { source: "training" },
      { image: "PHN2ZyB4bWxucz0i" },
      { image: `iVBORw0KGgo${"A".repeat(120_000)}` },
    ]) {
      await expect(db.as(ALICE, () => add(crypto.randomUUID(), fields))).rejects.toThrow(
        /check constraint/,
      );
    }
  });

  it("can't be read without signing in", async () => {
    await expect(db.as(null, () => db.query("select * from handwriting_samples"))).rejects.toThrow(
      /permission denied/,
    );
  });
});
