import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

const ALICE = "user_alice";
const BOB = "user_bob";

const STEP = {
  instruction: "Click Insert, at the top.",
  successCondition: "The Insert tab is selected.",
  hint: "Pivot tables are made from the Insert tab.",
  explicit: "Click the Insert tab at the top left.",
  hints: 0,
  checks: 0,
  misses: 0,
  outcome: null,
};
const STEPS = JSON.stringify([STEP]);

let db: Db;
let aliceWalkthrough: string;

/** Runs `fn` as the API service (secret key: the service_role, which bypasses RLS). */
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set role service_role");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

function insert(user: string, columns: Record<string, unknown> = {}) {
  const values = {
    user_id: user,
    title: "Pivot tables",
    goal: "teach me how to make a pivot table",
    app_exe_name: "excel.exe",
    steps: STEPS,
    ...columns,
  };
  const names = Object.keys(values);
  return db.query<{ id: string }>(
    `insert into walkthroughs (${names.join(", ")})
     values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(values),
  );
}

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
  await db.as(BOB, () => db.query("insert into profiles default values"));
  const { rows } = await asService(() => insert(ALICE));
  aliceWalkthrough = rows[0]?.id ?? "";
});

describe("walkthroughs", () => {
  it("lets the owner read theirs, and nobody else", async () => {
    const alice = await db.as(ALICE, () => db.query("select id, status from walkthroughs"));
    expect(alice.rows).toEqual([{ id: aliceWalkthrough, status: "active" }]);
    const bob = await db.as(BOB, () => db.query("select id from walkthroughs"));
    expect(bob.rows).toEqual([]);
    await expect(db.as(null, () => db.query("select id from walkthroughs"))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("only lets the API service write them", async () => {
    await db.as(ALICE, async () => {
      await expect(insert(ALICE)).rejects.toThrow(/permission denied/);
      await expect(
        db.query("update walkthroughs set hints_used = 0 where id = $1", [aliceWalkthrough]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("lets the owner delete theirs, and only theirs", async () => {
    const { rows } = await asService(() => insert(ALICE, { title: "To delete" }));
    const id = rows[0]?.id;
    const bob = await db.as(BOB, () => db.query("delete from walkthroughs where id = $1", [id]));
    expect(bob.affectedRows).toBe(0);
    const alice = await db.as(ALICE, () =>
      db.query("delete from walkthroughs where id = $1", [id]),
    );
    expect(alice.affectedRows).toBe(1);
  });

  it("keeps the current step inside the plan, and the status consistent", async () => {
    await asService(async () => {
      await expect(insert(ALICE, { current_step: 1 })).rejects.toThrow(/check constraint/);
      await expect(insert(ALICE, { status: "completed" })).rejects.toThrow(/check constraint/);
      await expect(insert(ALICE, { status: "skipped" })).rejects.toThrow(/check constraint/);
      await expect(insert(ALICE, { completed_at: new Date().toISOString() })).rejects.toThrow(
        /check constraint/,
      );
      const finished = await insert(ALICE, {
        status: "completed",
        completed_at: new Date().toISOString(),
      });
      expect(finished.rows).toHaveLength(1);
    });
  });

  it("refuses an empty or oversized plan, paths for app names, and long text", async () => {
    await asService(async () => {
      await expect(insert(ALICE, { steps: "[]" })).rejects.toThrow(/check constraint/);
      await expect(insert(ALICE, { steps: "{}" })).rejects.toThrow(/check constraint/);
      const sixteen = JSON.stringify(Array.from({ length: 16 }, () => STEP));
      await expect(insert(ALICE, { steps: sixteen })).rejects.toThrow(/check constraint/);
      await expect(insert(ALICE, { app_exe_name: "C:\\Users\\a\\excel.exe" })).rejects.toThrow(
        /check constraint/,
      );
      await expect(insert(ALICE, { goal: "x".repeat(201) })).rejects.toThrow(/check constraint/);
    });
  });

  it("goes with the account", async () => {
    const carol = "user_carol";
    await db.as(carol, () => db.query("insert into profiles default values"));
    await asService(() => insert(carol));
    await db.query("delete from profiles where id = $1", [carol]);
    const left = await db.query("select id from walkthroughs where user_id = $1", [carol]);
    expect(left.rows).toEqual([]);
  });
});
