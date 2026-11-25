import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

/** Handoff (docs/HANDOFF_FEATURE.md): only the API service reads or writes these tables. */
const ALICE = "user_alice";
const BOB = "user_bob";
const LIVE = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";

let db: Db;

async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set role service_role");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

const insertHandoff = (id: string, expires: string, status = "sent") =>
  asService(() =>
    db.query(
      `insert into handoffs (id, sender_id, sender_name, title, status, expires_at, storage_path, wrapped_key, size_bytes)
       values ($1::uuid, $2::text, 'Alice', 'Fix emails', $3, $4, $2::text || '/' || $1::text || '.bin', 'w', 100)`,
      [id, ALICE, status, expires],
    ),
  );

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
  await db.as(BOB, () => db.query("insert into profiles default values"));
  await insertHandoff(LIVE, "2999-01-01T00:00:00Z");
  await insertHandoff(OLD, "2000-01-01T00:00:00Z");
  await asService(() =>
    db.query(
      `insert into handoff_members (handoff_id, email, role) values ($1, 'bob@example.com', 'recipient');
       `,
      [LIVE],
    ),
  );
  await asService(() =>
    db.query(`insert into handoff_events (handoff_id, actor_id, type) values ($1, $2, 'created')`, [
      OLD,
      ALICE,
    ]),
  );
});

describe("handoff tables", () => {
  it.each(["handoffs", "handoff_members", "handoff_events", "handoff_replies"])(
    "are closed to signed-in users: %s",
    async (table) => {
      for (const user of [ALICE, BOB]) {
        await expect(db.as(user, () => db.query(`select * from ${table}`))).rejects.toThrow();
      }
    },
  );

  it("can't be written by a signed-in user, even the sender", async () => {
    await expect(
      db.as(ALICE, () =>
        db.query(
          `insert into handoffs (id, sender_id, sender_name, title, expires_at, storage_path, size_bytes)
           values (gen_random_uuid(), $1::text, 'A', 't', now(), $1::text || '/x.bin', 1)`,
          [ALICE],
        ),
      ),
    ).rejects.toThrow();
  });

  it("checks what's stored: a storage path in the sender's folder, a lowercase email", async () => {
    await expect(
      asService(() =>
        db.query(
          `insert into handoffs (id, sender_id, sender_name, title, expires_at, storage_path, size_bytes)
           values (gen_random_uuid(), $1, 'A', 't', now(), 'user_bob/33333333-3333-4333-8333-333333333333.bin', 1)`,
          [ALICE],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      asService(() =>
        db.query(
          `insert into handoff_members (handoff_id, email, role) values ($1, 'Bob@X.com', 'recipient')`,
          [LIVE],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      asService(() =>
        db.query(`insert into handoff_events (handoff_id, type) values ($1, 'said hello')`, [LIVE]),
      ),
    ).rejects.toThrow();
  });

  it("purges expired and revoked handoffs with everything they hold", async () => {
    const { rows } = await asService(() =>
      db.query<{ purge_handoffs: string }>("select * from purge_handoffs(now())"),
    );
    expect(rows.map((r) => Object.values(r)[0])).toEqual([`${ALICE}/${OLD}.bin`]);
    const left = await asService(() =>
      db.query<{ n: number }>("select count(*)::int as n from handoff_events"),
    );
    expect(left.rows[0]?.n).toBe(0);
    const live = await asService(() =>
      db.query<{ n: number }>("select count(*)::int as n from handoffs"),
    );
    expect(live.rows[0]?.n).toBe(1);
  });

  it("keeps the purge function away from users", async () => {
    await expect(
      db.as(ALICE, () => db.query("select * from purge_handoffs(now())")),
    ).rejects.toThrow();
  });
});
