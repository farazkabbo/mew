import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

/** K8 follow-up: the opt-in check reminders setting (20261106000000_check_reminders). */

const ALICE = "user_alice";
let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
});

const set = (settings: object) =>
  db.as(ALICE, () =>
    db.query("update profiles set settings = $1 where id = $2", [JSON.stringify(settings), ALICE]),
  );

describe("check reminders", () => {
  it("is a true or false setting", async () => {
    await set({ notify_moment_checks: true });
    await expect(set({ notify_moment_checks: "yes" })).rejects.toThrow(/check constraint/);
  });
});
