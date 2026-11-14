import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

const AYESHA = "user_ayesha";
const SECOND = "user_second_account";
const DEVICE = "a".repeat(64);
let db: Db;

/** Runs `fn` as the API service (secret key: the service_role, which bypasses RLS). */
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set role service_role");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

const reserve = (user: string, device: string | null, limit = 8) =>
  asService(() =>
    db.query<{ id: string }>("select public.reserve_question($1, $2, $3) as id", [
      user,
      device,
      limit,
    ]),
  ).then((r) => r.rows[0]?.id ?? null);

const used = async (user: string) =>
  (
    await db.query<{ used: number }>("select used from public.question_quota where user_id = $1", [
      user,
    ])
  ).rows[0]?.used;

beforeAll(async () => {
  db = await createTestDb();
});

describe("the free allowance", () => {
  // PGlite has one connection, so these run one after another here; on Postgres the guard
  // ("used < limit" in the UPDATE) is re-checked after the row lock, so it holds in parallel too.
  it("lets exactly 8 of 20 questions through, however they arrive", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => reserve(AYESHA, DEVICE)),
    );
    const through = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(through).toHaveLength(8);
    expect(refused).toHaveLength(12);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toContain("QUOTA_EXCEEDED");
    expect(await used(AYESHA)).toBe(8);
  });

  it("starts a new account on a used-up computer at nothing left", async () => {
    await expect(reserve(SECOND, DEVICE)).rejects.toThrow("QUOTA_EXCEEDED");
    // Nothing was kept for the refused question (not even the row: it all rolled back).
    expect((await used(SECOND)) ?? 0).toBe(0);
    // The same account on another computer (or the web) still has its own 8.
    expect(await reserve(SECOND, "b".repeat(64))).toBeTruthy();
    expect(await reserve(SECOND, null)).toBeTruthy();
  });

  it("gives a failed question back, once", async () => {
    const user = "user_refund";
    const id = await reserve(user, null);
    expect(await used(user)).toBe(1);
    const refund = () =>
      asService(() => db.query<{ ok: boolean }>("select public.refund_question($1) as ok", [id]));
    expect((await refund()).rows[0]?.ok).toBe(true);
    expect((await refund()).rows[0]?.ok).toBe(false);
    expect(await used(user)).toBe(0);
    const { rows } = await db.query<{ status: string }>(
      "select status from public.question_log where id = $1",
      [id],
    );
    expect(rows[0]?.status).toBe("refunded");
  });

  it("records what an answered question cost, and an answered one can't be refunded", async () => {
    const user = "user_finish";
    const id = await reserve(user, null);
    await asService(() =>
      db.query("select public.finish_question($1, $2, $3, $4)", [id, "gemini", 2282, 400]),
    );
    const refunded = await asService(() =>
      db.query<{ ok: boolean }>("select public.refund_question($1) as ok", [id]),
    );
    expect(refunded.rows[0]?.ok).toBe(false);
    expect(await used(user)).toBe(1);
  });

  it("never runs out for the unlimited, and counts no computer for them", async () => {
    const founder = "user_founder";
    for (let i = 0; i < 10; i++) {
      await asService(() =>
        db.query("select public.reserve_question($1, $2, 8, false, true)", [
          founder,
          "c".repeat(64),
        ]),
      );
    }
    expect(await used(founder)).toBe(10);
    const { rows } = await db.query("select * from public.device_quota where device_hash = $1", [
      "c".repeat(64),
    ]);
    expect(rows).toHaveLength(0);
  });

  it("lets a learner read only their own allowance, and change nothing", async () => {
    const mine = await db.as(AYESHA, () => db.query("select used from public.question_quota"));
    expect(mine.rows).toEqual([{ used: 8 }]);
    await expect(
      db.as(AYESHA, () => db.query("update public.question_quota set used = 0")),
    ).rejects.toThrow();
    await expect(
      db.as(AYESHA, () => db.query("select public.reserve_question($1, null, 8)", [AYESHA])),
    ).rejects.toThrow();
    await expect(
      db.as(AYESHA, () => db.query("select * from public.question_log")),
    ).rejects.toThrow();
    await expect(
      db.as(null, () => db.query("select * from public.question_quota")),
    ).rejects.toThrow();
  });
});

describe("who may call the allowance functions", () => {
  const calls = [
    ["reserve_question", "select public.reserve_question('user_attacker', null, 8, false, true)"],
    ["refund_question", "select public.refund_question('00000000-0000-4000-8000-000000000000')"],
    [
      "finish_question",
      "select public.finish_question('00000000-0000-4000-8000-000000000000', 'm', 1, 1)",
    ],
    ["ask_to_notify", "select public.ask_to_notify('user_attacker', 8)"],
  ] as const;

  it.each(calls)(
    "%s: not the browser roles (anon, signed in), only the API service",
    async (_, sql) => {
      await expect(db.as(null, () => db.query(sql))).rejects.toThrow(/permission denied/);
      await expect(db.as(AYESHA, () => db.query(sql))).rejects.toThrow(/permission denied/);
      await expect(asService(() => db.query(sql))).resolves.toBeDefined();
      // The API service's call really ran: leave nothing behind for the other tests.
      await asService(() =>
        db.exec(
          "delete from public.question_log where user_id = 'user_attacker'; " +
            "delete from public.question_quota where user_id = 'user_attacker';",
        ),
      );
    },
  );
});

describe("emailing when more open up", () => {
  it("flags a learner who ran out, and only the API service can", async () => {
    await asService(() => db.query("select public.ask_to_notify($1, 8)", ["user_ran_out"]));
    await asService(() => db.query("select public.ask_to_notify($1, 8)", [AYESHA]));
    const { rows } = await db.query<{ user_id: string }>(
      "select user_id from public.question_quota where notify_when_more order by user_id",
    );
    expect(rows.map((r) => r.user_id)).toEqual([AYESHA, "user_ran_out"]);
    // Ayesha's count is untouched.
    expect(await used(AYESHA)).toBe(8);
    await expect(
      db.as(AYESHA, () => db.query("select public.ask_to_notify($1, 8)", [AYESHA])),
    ).rejects.toThrow();
    await expect(
      db.as(AYESHA, () => db.query("update public.question_quota set notify_when_more = false")),
    ).rejects.toThrow();
  });
});
