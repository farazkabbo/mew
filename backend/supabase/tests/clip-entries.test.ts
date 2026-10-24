import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

const ALICE = "user_alice";
const BOB = "user_bob";
const SESSION = "11111111-1111-4111-8111-111111111111";
const ENTRY = JSON.stringify({
  turns: [{ question: "Explain this", steps: ["One."], summary: "S." }],
  strokeSteps: [],
  conceptHints: [],
});

let db: Db;

async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set role service_role");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

let next = 0;
function insert(user: string, columns: Record<string, unknown>) {
  next++;
  const id = `55555555-5555-4555-8555-${String(next).padStart(12, "0")}`;
  const values = {
    id,
    user_id: user,
    storage_path: `${user}/${id}.jpg`,
    width: 100,
    height: 100,
    pixel_ratio: 1,
    source_app: "msedge.exe",
    captured_at: new Date().toISOString(),
    ...columns,
  };
  const names = Object.keys(values);
  return db.query<{ id: string }>(
    `insert into clips (${names.join(", ")})
     values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(values),
  );
}

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
  await db.as(BOB, () => db.query("insert into profiles default values"));
});

describe("clip entries", () => {
  it("stores an entry with its session and explanation; an ordinary clip has neither", async () => {
    await asService(async () => {
      await insert(ALICE, { kind: "entry", session_id: SESSION, entry: ENTRY });
      await insert(ALICE, {});
      await expect(insert(ALICE, { kind: "entry", entry: ENTRY })).rejects.toThrow(
        /check constraint/,
      );
      await expect(insert(ALICE, { session_id: SESSION, entry: ENTRY })).rejects.toThrow(
        /check constraint/,
      );
      await expect(insert(ALICE, { kind: "note" })).rejects.toThrow(/check constraint/);
    });
    const kinds = await db.as(ALICE, () => db.query("select kind from clips order by kind"));
    expect(kinds.rows).toEqual([{ kind: "clip" }, { kind: "entry" }]);
  });

  it("keeps one entry per session and owner", async () => {
    await asService(async () => {
      await expect(
        insert(ALICE, { kind: "entry", session_id: SESSION, entry: ENTRY }),
      ).rejects.toThrow(/duplicate key/);
      // Another student's session can have the same id (it's theirs).
      await insert(BOB, { kind: "entry", session_id: SESSION, entry: ENTRY });
    });
  });

  it("never lets an owner change an entry, only note its page", async () => {
    for (const column of ["entry", "student_strokes", "kind", "session_id", "revision"]) {
      await db.as(ALICE, async () => {
        await expect(db.query(`update clips set ${column} = ${column}`)).rejects.toThrow(
          /permission denied/,
        );
      });
    }
    const bob = await db.as(BOB, () => db.query("select session_id from clips"));
    expect(bob.rows).toEqual([{ session_id: SESSION }]);
  });

  it("refuses an oversized explanation", async () => {
    const huge = JSON.stringify({ turns: [{ summary: "x".repeat(200_000) }] });
    await asService(async () => {
      await expect(
        insert(ALICE, {
          kind: "entry",
          session_id: "22222222-2222-4222-8222-222222222222",
          entry: huge,
        }),
      ).rejects.toThrow(/check constraint/);
    });
  });
});
