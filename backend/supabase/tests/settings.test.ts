import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

const ALICE = "user_alice";
let db: Db;

const set = (settings: object) =>
  db.as(ALICE, () =>
    db.query("update profiles set settings = $1 where id = $2", [JSON.stringify(settings), ALICE]),
  );

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
});

describe("profile settings", () => {
  it("accepts the settings screen's values", async () => {
    await set({
      mew_threshold: 0.85,
      answer_style: "direct",
      captions: false,
      auto_check: true,
      listen_on_open: true,
      voice_id: "JBFqnCBsd6RMkjVDRZzb",
      mew_logging_opt_in: true,
      onboarded: true,
      some_future_key: "kept",
    });
    await set({ voice_id: null });
  });

  it.each([
    [{ answer_style: "verbose" }],
    [{ captions: "yes" }],
    [{ onboarded: 1 }],
    [{ listen_on_open: "true" }],
    // The voice id ends up in an upstream URL path: only the ID alphabet.
    [{ voice_id: "../../v1/user" }],
    [{ voice_id: 42 }],
    [{ mew_threshold: 3 }],
  ])("refuses %j", async (settings) => {
    await expect(set(settings)).rejects.toThrow(/check constraint/);
  });
});
