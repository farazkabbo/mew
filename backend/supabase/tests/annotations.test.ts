import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

/** K9: live annotations (20261105000000_annotations). */

const ALICE = "user_alice";
const BOB = "user_bob";
const PAGE = "11111111-1111-4111-8111-111111111111";
const LINE = "22222222-2222-4222-8222-222222222222";
const GROUP = "33333333-3333-4333-8333-333333333333";
let db: Db;

const mark = (id: string, fields: Record<string, unknown> = {}) =>
  db.query(
    `insert into annotations (id, page_id, line_id, mark_kind, verdict, checker_method,
       recognized_text, confidence, stroke_group_id, note, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     on conflict (id) do update set dismissed_as = excluded.dismissed_as`,
    [
      id,
      PAGE,
      LINE,
      fields.mark_kind ?? "error",
      fields.verdict ?? "incorrect",
      fields.checker_method ?? "math",
      fields.recognized_text ?? "3x = 26",
      fields.confidence ?? 0.92,
      GROUP,
      fields.note ?? "sign?",
    ],
  );

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
  await db.as(BOB, () => db.query("insert into profiles default values"));
});

describe("annotations", () => {
  it("are the student's own: written with their token, invisible to anyone else", async () => {
    const id = "44444444-4444-4444-8444-000000000001";
    await db.as(ALICE, () => mark(id));
    const mine = await db.as(ALICE, () => db.query("select user_id, note from annotations"));
    expect(mine.rows).toEqual([{ user_id: ALICE, note: "sign?" }]);
    expect((await db.as(BOB, () => db.query("select * from annotations"))).rows).toEqual([]);
    // Bob can't overwrite Alice's mark by its id.
    await expect(db.as(BOB, () => mark(id, { note: "x" }))).rejects.toThrow();
  });

  it("keep a 'not wrong' correction, and refuse what isn't a mark", async () => {
    const id = "44444444-4444-4444-8444-000000000002";
    await db.as(ALICE, () => mark(id));
    await db.as(ALICE, () =>
      db.query("update annotations set dismissed_as = 'not_wrong' where id = $1", [id]),
    );
    const row = await db.as(ALICE, () =>
      db.query("select dismissed_as from annotations where id = $1", [id]),
    );
    expect(row.rows).toEqual([{ dismissed_as: "not_wrong" }]);

    for (const fields of [
      { mark_kind: "smiley" },
      { verdict: "maybe" },
      { checker_method: "vibes" },
      { confidence: 2 },
      { note: "x".repeat(33) },
    ]) {
      await expect(db.as(ALICE, () => mark(crypto.randomUUID(), fields))).rejects.toThrow(
        /check constraint/,
      );
    }
  });

  it("can't change which page, line or user a mark is on", async () => {
    const id = "44444444-4444-4444-8444-000000000003";
    await db.as(ALICE, () => mark(id));
    await expect(
      db.as(ALICE, () => db.query("update annotations set page_id = $1 where id = $2", [LINE, id])),
    ).rejects.toThrow(/stays on its page/);
  });

  it("are upserted whole by id, as the API service sends them", async () => {
    const id = "44444444-4444-4444-8444-000000000004";
    const upsert = (resolved: string | null) =>
      db.as(ALICE, () =>
        db.query(
          `insert into annotations (id, page_id, line_id, mark_kind, verdict, checker_method,
             stroke_group_id, created_at, resolved_at)
           values ($1, $2, $3, 'error', 'incorrect', 'math', $4, '2026-10-26T10:00:00Z', $5)
           on conflict (id) do update set page_id = excluded.page_id,
             line_id = excluded.line_id, stroke_group_id = excluded.stroke_group_id,
             created_at = excluded.created_at, resolved_at = excluded.resolved_at`,
          [id, PAGE, LINE, GROUP, resolved],
        ),
      );
    await upsert(null);
    await upsert("2026-10-26T10:01:00Z");
    const row = await db.as(ALICE, () =>
      db.query<{ resolved_at: Date }>("select resolved_at from annotations where id = $1", [id]),
    );
    expect(row.rows[0]?.resolved_at.toISOString()).toBe("2026-10-26T10:01:00.000Z");
  });

  it("make live_annotation an attempt source", async () => {
    const constraint = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
       where conname = 'attempts_source_check'`,
    );
    expect(constraint.rows[0]?.def).toContain("live_annotation");
  });
});
