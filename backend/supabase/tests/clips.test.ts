import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

const ALICE = "user_alice";
const BOB = "user_bob";
const PAGE = "44444444-4444-4444-8444-444444444444";

let db: Db;
let aliceClip: string;

/** Runs `fn` as the API service (secret key: the service_role, which bypasses RLS). */
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set role service_role");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

const CLIP_ID = "55555555-5555-4555-8555-555555555555";

function insertClip(user: string, id: string, path = `${user}/${id}.jpg`) {
  return db.query<{ id: string }>(
    `insert into clips (id, user_id, storage_path, width, height, pixel_ratio, source_app,
       source_title, source_url, annotations, ocr_text, captured_at)
     values ($1, $2, $3, 1200, 600, 1.5, 'msedge.exe', 'Worksheet', 'https://example.com/w',
       '[]', 'Question 3', now())
     returning id`,
    [id, user, path],
  );
}

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
  await db.as(BOB, () => db.query("insert into profiles default values"));
  const { rows } = await asService(() => insertClip(ALICE, CLIP_ID));
  aliceClip = rows[0]?.id ?? "";
  // As the database owner: the test harness doesn't grant storage to service_role.
  await db.query("insert into storage.objects (bucket_id, name) values ('clips', $1)", [
    `${ALICE}/${CLIP_ID}.jpg`,
  ]);
});

describe("clips", () => {
  it("lets the owner read their clip, and nobody else", async () => {
    const alice = await db.as(ALICE, () => db.query("select id, ocr_text from clips"));
    expect(alice.rows).toEqual([{ id: aliceClip, ocr_text: "Question 3" }]);
    const bob = await db.as(BOB, () => db.query("select id from clips"));
    expect(bob.rows).toEqual([]);
    const anon = db.as(null, () => db.query("select id from clips"));
    await expect(anon).rejects.toThrow(/permission denied/);
  });

  it("only lets clips be created by the API service", async () => {
    await db.as(ALICE, async () => {
      await expect(insertClip(ALICE, "66666666-6666-4666-8666-666666666666")).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it("lets the owner note the notebook page, but change nothing else", async () => {
    await db.as(ALICE, () =>
      db.query("update clips set notebook_page_id = $1 where id = $2", [PAGE, aliceClip]),
    );
    const row = await db.as(ALICE, () => db.query("select notebook_page_id from clips"));
    expect(row.rows).toEqual([{ notebook_page_id: PAGE }]);
    for (const column of ["storage_path", "user_id", "source_url", "annotations", "ocr_text"]) {
      await db.as(ALICE, async () => {
        await expect(
          db.query(`update clips set ${column} = ${column} where id = $1`, [aliceClip]),
        ).rejects.toThrow(/permission denied/);
      });
    }
    // Bob can't touch it.
    const bobUpdate = await db.as(BOB, () =>
      db.query("update clips set notebook_page_id = null where id = $1", [aliceClip]),
    );
    expect(bobUpdate.affectedRows).toBe(0);
  });

  it("keeps each image in its owner's folder", async () => {
    await asService(async () => {
      await expect(
        insertClip(ALICE, "77777777-7777-4777-8777-777777777777", `${BOB}/x.jpg`),
      ).rejects.toThrow(/violates check constraint/);
      await expect(
        insertClip(ALICE, "88888888-8888-4888-8888-888888888888", `${ALICE}/../x.jpg`),
      ).rejects.toThrow(/violates check constraint/);
    });
  });

  it("refuses links that aren't https and oversized text", async () => {
    await asService(async () => {
      await expect(
        db.query(
          `insert into clips (user_id, storage_path, width, height, pixel_ratio, source_app,
             source_url, captured_at)
           values ($1, $2, 10, 10, 1, 'msedge.exe', 'javascript:alert(1)', now())`,
          [ALICE, `${ALICE}/99999999-9999-4999-8999-999999999999.jpg`],
        ),
      ).rejects.toThrow(/violates check constraint/);
      await expect(
        db.query(
          `insert into clips (user_id, storage_path, width, height, pixel_ratio, source_app,
             ocr_text, captured_at)
           values ($1, $2, 10, 10, 1, 'msedge.exe', repeat('x', 8001), now())`,
          [ALICE, `${ALICE}/99999999-9999-4999-8999-999999999999.jpg`],
        ),
      ).rejects.toThrow(/violates check constraint/);
    });
  });

  it("lets only the owner read and delete the image; users can't upload", async () => {
    const path = `${ALICE}/${CLIP_ID}.jpg`;
    const alice = await db.as(ALICE, () =>
      db.query("select name from storage.objects where bucket_id = 'clips'"),
    );
    expect(alice.rows).toEqual([{ name: path }]);
    const bob = await db.as(BOB, () =>
      db.query("select name from storage.objects where bucket_id = 'clips'"),
    );
    expect(bob.rows).toEqual([]);
    for (const user of [ALICE, BOB]) {
      await db.as(user, async () => {
        await expect(
          db.query("insert into storage.objects (bucket_id, name) values ('clips', $1)", [
            `${user}/forged.jpg`,
          ]),
        ).rejects.toThrow(/row-level security/);
      });
    }
    const bucket = await db.query<{ public: boolean; file_size_limit: number; types: string[] }>(
      "select public, file_size_limit, allowed_mime_types as types from storage.buckets where id = 'clips'",
    );
    expect(bucket.rows).toEqual([
      { public: false, file_size_limit: 3145728, types: ["image/jpeg"] },
    ]);

    const bobDelete = await db.as(BOB, () =>
      db.query("delete from storage.objects where name = $1", [path]),
    );
    expect(bobDelete.affectedRows).toBe(0);
    await db.as(ALICE, () => db.query("delete from storage.objects where name = $1", [path]));
    const left = await db.query("select name from storage.objects where name = $1", [path]);
    expect(left.rows).toEqual([]);
  });

  it("goes with the account", async () => {
    await asService(() => db.query("delete from profiles where id = $1", [ALICE]));
    const left = await asService(() =>
      db.query("select id from clips where user_id = $1", [ALICE]),
    );
    expect(left.rows).toEqual([]);
  });
});
