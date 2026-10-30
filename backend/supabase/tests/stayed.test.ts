import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

/** U6: "stayed" on moment checks, and the per-node counts (20261111000000_stayed). */

const ALICE = "user_alice";
const BOB = "user_bob";
const PHYSICS = "0f1e2d3c-4b5a-4968-8776-655443322110";
const OPTICS = "0f1e2d3c-4b5a-4968-8776-655443322111";
const BOBS = "0f1e2d3c-4b5a-4968-8776-655443322119";
const CLIP = "66666666-6666-4666-8666-000000000001";
const BOB_CLIP = "66666666-6666-4666-8666-000000000002";
let db: Db;

async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set role service_role");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

const sync = (user: string, id: string, title: string, parent: string | null = null) =>
  db.as(user, () =>
    db.query("select public.sync_notebook_tree($1::jsonb)", [
      JSON.stringify([
        {
          id,
          parent_id: parent,
          title,
          position: "a0",
          child_label: "Chapters",
          icon: null,
          color: null,
          course_id: null,
          deleted_at: null,
          edited_at: new Date().toISOString(),
        },
      ]),
    ]),
  );

/** A check made `daysAgo` days ago, filed in `node`. */
const check = async (user: string, clip: string, node: string, daysAgo: number) =>
  (
    await asService(() =>
      db.query<{ id: string }>(
        `insert into moment_checks (user_id, clip_id, node_id, prompt, kind, answer_key, status,
           due_at, created_at)
         values ($1, $2, $3, 'Why?', 'short', 'Because.', 'active', now(),
           now() - make_interval(days => $4))
         returning id`,
        [user, clip, node, daysAgo],
      ),
    )
  ).rows[0]?.id ?? "";

const clip = (id: string, user: string) =>
  asService(() =>
    db.query(
      `insert into clips (id, user_id, storage_path, width, height, pixel_ratio, source_app,
         captured_at)
       values ($1, $2, $3, 100, 100, 1, 'msedge.exe', now())`,
      [id, user, `${user}/${id}.jpg`],
    ),
  );

const stayedAt = async (id: string) =>
  (
    await asService(() =>
      db.query<{ stayed_at: Date | null }>("select stayed_at from moment_checks where id = $1", [
        id,
      ]),
    )
  ).rows[0]?.stayed_at ?? null;

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
  await db.as(BOB, () => db.query("insert into profiles default values"));
  await sync(ALICE, PHYSICS, "Physics");
  await sync(ALICE, OPTICS, "Optics", PHYSICS);
  await sync(BOB, BOBS, "Bob's notebook");
  await clip(CLIP, ALICE);
  await clip(BOB_CLIP, BOB);
});

describe("stayed", () => {
  it("is set once by its owner, and never moved or cleared", async () => {
    const id = await check(ALICE, CLIP, PHYSICS, 3);
    const set = (value: string | null) =>
      db.as(ALICE, () =>
        db.query("update moment_checks set stayed_at = $2 where id = $1", [id, value]),
      );
    await set(new Date().toISOString());
    const first = await stayedAt(id);
    expect(first).not.toBeNull();
    // A retried answer (or anything else) keeps the first time.
    await set(new Date(Date.now() + 60_000).toISOString());
    await set(null);
    expect(await stayedAt(id)).toEqual(first);
  });

  it("can't be sooner than a day after the check was made", async () => {
    const id = await check(ALICE, CLIP, PHYSICS, 0);
    await expect(
      db.as(ALICE, () =>
        db.query("update moment_checks set stayed_at = now() where id = $1", [id]),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("is counted per notebook, for its owner only", async () => {
    // One filed in a chapter counts for its notebook.
    const chapter = await check(ALICE, CLIP, OPTICS, 10);
    await db.as(ALICE, () =>
      db.query("update moment_checks set stayed_at = now() - interval '8 days' where id = $1", [
        chapter,
      ]),
    );
    const bobs = await check(BOB, BOB_CLIP, BOBS, 2);
    await db.as(BOB, () =>
      db.query("update moment_checks set stayed_at = now() where id = $1", [bobs]),
    );
    const mine = await db.as(ALICE, () =>
      db.query<{ notebook_id: string; stayed_count: number }>(
        "select notebook_id, stayed_count, stayed_week from notebook_stayed",
      ),
    );
    expect(mine.rows).toEqual([
      expect.objectContaining({ notebook_id: PHYSICS, stayed_count: 2, stayed_week: 1 }),
    ]);
    const theirs = await db.as(BOB, () =>
      db.query<{ notebook_id: string; stayed_count: number }>(
        "select notebook_id, stayed_count, stayed_week from notebook_stayed",
      ),
    );
    expect(theirs.rows).toEqual([
      expect.objectContaining({ notebook_id: BOBS, stayed_count: 1, stayed_week: 1 }),
    ]);
    await expect(
      db.as(BOB, () => db.query("update moment_checks set prompt = 'x' where id = $1", [bobs])),
    ).rejects.toThrow(/permission denied/);
  });
});
