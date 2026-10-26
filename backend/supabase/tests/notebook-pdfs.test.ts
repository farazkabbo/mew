import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

/** K4: imported PDFs (migration 20261102000000_notebook_pdfs.sql). */

const ALICE = "user_alice";
const BOB = "user_bob";
let db: Db;
let next = 0;

function pdfId(): string {
  next++;
  return `77777777-7777-4777-8777-${String(next).padStart(12, "0")}`;
}

function insert(user: string, owner = user, extra: Record<string, unknown> = {}) {
  const id = pdfId();
  const values = {
    id,
    storage_path: `${owner}/${id}.pdf`,
    file_name: "Physics 101.pdf",
    byte_size: 1000,
    page_count: 12,
    outline: JSON.stringify([{ title: "Chapter 1", pageIndex: 0 }]),
    ...extra,
  };
  const names = Object.keys(values);
  return db.as(user, () =>
    db.query(
      `insert into notebook_pdfs (${names.join(", ")})
       values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id, user_id`,
      Object.values(values),
    ),
  );
}

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
  await db.as(BOB, () => db.query("insert into profiles default values"));
});

describe("notebook PDFs", () => {
  it("are the student's own: kept in their folder, invisible to anyone else", async () => {
    const { rows } = await insert(ALICE);
    expect(rows[0]).toMatchObject({ user_id: ALICE });
    const bobSees = await db.as(BOB, () => db.query("select * from notebook_pdfs"));
    expect(bobSees.rows).toEqual([]);
    // Bob can't change or delete Alice's.
    await db.as(BOB, () => db.query("delete from notebook_pdfs"));
    const still = await db.as(ALICE, () => db.query("select id from notebook_pdfs"));
    expect(still.rows).toHaveLength(1);
  });

  it("refuses another student's folder, bad sizes and a huge outline", async () => {
    await expect(insert(ALICE, BOB)).rejects.toThrow(/check constraint/);
    await expect(insert(ALICE, ALICE, { page_count: 0 })).rejects.toThrow(/check constraint/);
    await expect(insert(ALICE, ALICE, { byte_size: 200 * 1024 * 1024 })).rejects.toThrow(
      /check constraint/,
    );
    const outline = JSON.stringify(
      Array.from({ length: 201 }, (_, i) => ({ title: "x", pageIndex: i })),
    );
    await expect(insert(ALICE, ALICE, { outline })).rejects.toThrow(/check constraint/);
    // The owner is the session, never what the browser says.
    await expect(insert(ALICE, ALICE, { user_id: BOB })).rejects.toThrow(/permission denied/);
  });

  it("keep their files in a private bucket, one folder per student", async () => {
    const { rows } = await db.query(
      "select public, file_size_limit from storage.buckets where id = 'pdfs'",
    );
    expect(rows[0]).toEqual({ public: false, file_size_limit: 104857600 });
    await db.as(ALICE, () =>
      db.query("insert into storage.objects (bucket_id, name) values ('pdfs', 'user_alice/a.pdf')"),
    );
    await expect(
      db.as(ALICE, () =>
        db.query("insert into storage.objects (bucket_id, name) values ('pdfs', 'user_bob/a.pdf')"),
      ),
    ).rejects.toThrow(/row-level security/);
    const bobSees = await db.as(BOB, () =>
      db.query("select * from storage.objects where bucket_id = 'pdfs'"),
    );
    expect(bobSees.rows).toEqual([]);
  });

  it("can name the course they became (only the student's own)", async () => {
    const course = await db.as(ALICE, () =>
      db.query<{ id: string }>("insert into courses (title) values ('Physics') returning id"),
    );
    const bobsCourse = await db.as(BOB, () =>
      db.query<{ id: string }>("insert into courses (title) values ('Bio') returning id"),
    );
    const { rows } = await insert(ALICE);
    const id = (rows[0] as { id: string }).id;
    await db.as(ALICE, () =>
      db.query("update notebook_pdfs set course_id = $1 where id = $2", [course.rows[0]?.id, id]),
    );
    await expect(
      db.as(ALICE, () =>
        db.query("update notebook_pdfs set course_id = $1 where id = $2", [
          bobsCourse.rows[0]?.id,
          id,
        ]),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("let course passages know their chapter", async () => {
    const { rows } = await db.query(
      "select column_name from information_schema.columns where table_name = 'chunks' and column_name = 'notebook_node_id'",
    );
    expect(rows).toHaveLength(1);
  });
});
