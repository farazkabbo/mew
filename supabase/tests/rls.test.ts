import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

/** The single row a query must return; fails loudly instead of asserting non-null. */
async function one<T>(query: Promise<{ rows: T[] }>): Promise<T> {
  const row = (await query).rows[0];
  if (row === undefined) throw new Error("expected the query to return a row");
  return row;
}

const ALICE = "user_alice";
const BOB = "user_bob";

let db: Db;
let aliceNotebook: string;
let alicePage: string;

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
  await db.as(BOB, () => db.query("insert into profiles default values"));
  aliceNotebook = await db.as(ALICE, async () => {
    const row = await one(
      db.query<{ id: string }>("insert into notebooks (title) values ('Physics') returning id"),
    );
    return row.id;
  });
  alicePage = await db.as(ALICE, async () => {
    const row = await one(
      db.query<{ id: string }>(
        "insert into pages (notebook_id, index) values ($1, 0) returning id",
        [aliceNotebook],
      ),
    );
    return row.id;
  });
});

function insertStroke(pageId: string, overrides: Record<string, unknown> = {}) {
  const stroke = {
    id: randomUUID(),
    page_id: pageId,
    author: "student",
    points: JSON.stringify([[0, 0, 0.5, 0]]),
    bbox: [0, 0, 10, 10],
    color: "#1d1c1a",
    width: 2,
    ...overrides,
  };
  return db.query(
    "insert into strokes (id, page_id, author, points, bbox, color, width) values ($1,$2,$3,$4,$5,$6,$7)",
    [
      stroke.id,
      stroke.page_id,
      stroke.author,
      stroke.points,
      stroke.bbox,
      stroke.color,
      stroke.width,
    ],
  );
}

const count = async (table: string) =>
  (await one(db.query<{ n: number }>(`select count(*)::int as n from ${table}`))).n;

describe("ownership defaults", () => {
  it("fills user_id from the JWT subject", async () => {
    const owner = await db.as(ALICE, () =>
      db.query<{ user_id: string }>("select user_id from notebooks where id = $1", [aliceNotebook]),
    );
    expect(owner.rows[0]?.user_id).toBe(ALICE);
  });
});

describe("isolation between users", () => {
  it("hides other users' rows", async () => {
    await db.as(ALICE, () => insertStroke(alicePage));
    for (const table of ["profiles", "notebooks", "pages", "strokes"]) {
      expect(await db.as(BOB, () => count(table)), table).toBe(table === "profiles" ? 1 : 0);
    }
  });

  it("does not let a user claim another user's id", async () => {
    await expect(
      db.as(BOB, () =>
        db.query("insert into notebooks (user_id, title) values ($1, 'x')", [ALICE]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("does not let a user attach pages or strokes to another user's notebook", async () => {
    await expect(
      db.as(BOB, () =>
        db.query("insert into pages (notebook_id, index) values ($1, 1)", [aliceNotebook]),
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(db.as(BOB, () => insertStroke(alicePage))).rejects.toThrow(/foreign key/);
  });

  it("silently affects nothing when updating or deleting another user's rows", async () => {
    const updated = await db.as(BOB, () =>
      db.query("update notebooks set title = 'pwned' where id = $1", [aliceNotebook]),
    );
    const deleted = await db.as(BOB, () =>
      db.query("delete from notebooks where id = $1", [aliceNotebook]),
    );
    expect(updated.affectedRows).toBe(0);
    expect(deleted.affectedRows).toBe(0);
    expect(await db.as(ALICE, () => count("notebooks"))).toBe(1);
  });
});

describe("column privileges", () => {
  it("forbids rewriting ownership or ids, even on own rows", async () => {
    await expect(
      db.as(ALICE, () => db.query("update notebooks set user_id = $1", [BOB])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.as(ALICE, () => db.query("update profiles set id = 'user_other'")),
    ).rejects.toThrow(/permission denied/);
  });

  it("allows updating permitted columns on own rows", async () => {
    const r = await db.as(ALICE, () =>
      db.query("update notebooks set title = 'Mechanics' where id = $1", [aliceNotebook]),
    );
    expect(r.affectedRows).toBe(1);
  });

  it("makes tutor_turns append-only", async () => {
    await db.as(ALICE, () =>
      db.query(
        "insert into tutor_turns (page_id, mew_label, transcript, response) values ($1, 'give_hint', 'stuck', '{}')",
        [alicePage],
      ),
    );
    await expect(
      db.as(ALICE, () => db.query("update tutor_turns set transcript = 'edited'")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("anonymous access", () => {
  it("is denied on every table", async () => {
    for (const table of [
      "profiles",
      "notebooks",
      "pages",
      "strokes",
      "tutor_turns",
      "mew_events",
    ]) {
      await expect(
        db.as(null, () => count(table)),
        table,
      ).rejects.toThrow(/permission denied/);
    }
  });
});

describe("mew_events opt-in", () => {
  const insertEvent = () =>
    db.query("insert into mew_events (input, output) values ('{}', '{\"label\": \"ignore\"}')");

  it("rejects logging until the user opts in, then allows it", async () => {
    await expect(db.as(BOB, insertEvent)).rejects.toThrow(/row-level security/);

    await db.as(BOB, () =>
      db.query(`update profiles set settings = '{"mew_logging_opt_in": true}'`),
    );
    await expect(db.as(BOB, insertEvent)).resolves.toBeTruthy();
  });

  it("only lets the human label be edited", async () => {
    await expect(
      db.as(BOB, () => db.query("update mew_events set human_label = 'answer_question'")),
    ).resolves.toBeTruthy();
    await expect(db.as(BOB, () => db.query(`update mew_events set output = '{}'`))).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("data validation", () => {
  it.each([
    ["a malformed color", { color: "red; drop table" }],
    ["a bbox with the wrong arity", { bbox: [0, 0, 1] }],
    ["a non-positive width", { width: 0 }],
    ["an unknown author", { author: "admin" }],
    ["non-array points", { points: JSON.stringify({ x: 1 }) }],
  ])("rejects strokes with %s", async (_label, overrides) => {
    await expect(db.as(ALICE, () => insertStroke(alicePage, overrides))).rejects.toThrow(
      /check constraint/,
    );
  });

  it("rejects an out-of-range mew threshold", async () => {
    await expect(
      db.as(ALICE, () => db.query(`update profiles set settings = '{"mew_threshold": 1.5}'`)),
    ).rejects.toThrow(/check constraint/);
  });

  it("maintains updated_at on update", async () => {
    const updatedAt = () =>
      db.as(ALICE, () =>
        one(
          db.query<{ updated_at: Date }>("select updated_at from notebooks where id = $1", [
            aliceNotebook,
          ]),
        ),
      );
    const before = await updatedAt();
    await db.as(ALICE, () =>
      db.query("update notebooks set title = 'Optics' where id = $1", [aliceNotebook]),
    );
    const after = await updatedAt();
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
});
