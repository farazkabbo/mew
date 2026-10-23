import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

const ALICE = "user_alice";
const BOB = "user_bob";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let db: Db;
let aliceDevice: string;
let bobDevice: string;

/** Runs `fn` as the API service (secret key: the service_role, which bypasses RLS). */
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set role service_role");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

const addToken = (user: string, hash: string) =>
  asService(async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into device_tokens (user_id, token_hash, device_name) values ($1, $2, 'Laptop')
       returning id`,
      [user, hash],
    );
    const row = rows[0];
    if (!row) throw new Error("expected a row");
    return row.id;
  });

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
  await db.as(BOB, () => db.query("insert into profiles default values"));
  aliceDevice = await addToken(ALICE, HASH_A);
  bobDevice = await addToken(BOB, HASH_B);
});

describe("device tokens", () => {
  it("lets a user list their own devices, without the token hash", async () => {
    const rows = await db.as(ALICE, () =>
      db.query("select id, device_name, scopes, revoked_at from device_tokens"),
    );
    expect(rows.rows).toEqual([
      { id: aliceDevice, device_name: "Laptop", scopes: ["screen"], revoked_at: null },
    ]);
    await expect(
      db.as(ALICE, () => db.query("select token_hash from device_tokens")),
    ).rejects.toThrow(/permission denied/);
  });

  it("never lets a user create a token", async () => {
    await expect(
      db.as(ALICE, () =>
        db.query(
          "insert into device_tokens (user_id, token_hash, device_name) values ($1, $2, 'x')",
          [ALICE, "c".repeat(64)],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("lets a user revoke their own device but not someone else's", async () => {
    const theirs = await db.as(ALICE, () =>
      db.query("update device_tokens set revoked_at = now() where id = $1", [bobDevice]),
    );
    expect(theirs.affectedRows).toBe(0);

    const own = await db.as(ALICE, () =>
      db.query("update device_tokens set revoked_at = now() where id = $1", [aliceDevice]),
    );
    expect(own.affectedRows).toBe(1);
  });

  it("never brings a revoked token back", async () => {
    const undo = await db.as(ALICE, () =>
      db.query("update device_tokens set revoked_at = null where id = $1", [aliceDevice]),
    );
    expect(undo.affectedRows).toBe(0);
    const { rows } = await asService(() =>
      db.query<{ revoked: boolean }>(
        "select revoked_at is not null as revoked from device_tokens where id = $1",
        [aliceDevice],
      ),
    );
    expect(rows[0]?.revoked).toBe(true);
  });

  it("only lets users change revoked_at", async () => {
    await expect(
      db.as(BOB, () =>
        db.query("update device_tokens set scopes = array['screen'], device_name = 'x'"),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("gives anonymous callers nothing", async () => {
    await expect(db.as(null, () => db.query("select id from device_tokens"))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("checks hashes, names and scopes", async () => {
    for (const [hash, name, scopes] of [
      ["not-a-hash", "Laptop", "{screen}"],
      ["d".repeat(64), "", "{screen}"],
      ["e".repeat(64), "Laptop", "{admin}"],
      ["f".repeat(64), "Laptop", "{}"],
    ]) {
      await expect(
        asService(() =>
          db.query(
            "insert into device_tokens (user_id, token_hash, device_name, scopes) values ($1, $2, $3, $4)",
            [ALICE, hash, name, scopes],
          ),
        ),
      ).rejects.toThrow(/violates check constraint/);
    }
  });

  it("goes away with the account", async () => {
    await db.query("delete from profiles where id = $1", [BOB]);
    const { rows } = await db.query("select id from device_tokens where id = $1", [bobDevice]);
    expect(rows).toEqual([]);
  });
});
