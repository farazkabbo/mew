import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

const ALICE = "user_alice";
const BOB = "user_bob";

let db: Db;
let course: string;
let source: string;
let chunkA: string;
let chunkB: string;

/** A 768-dimension vector pointing mostly along `axis` (pgvector text format). */
function vec(axis: number, wobble = 0): string {
  const v = Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : i === axis + 1 ? wobble : 0));
  return `[${v.join(",")}]`;
}

async function one<T>(query: Promise<{ rows: T[] }>): Promise<T> {
  const row = (await query).rows[0];
  if (row === undefined) throw new Error("expected a row");
  return row;
}

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
  await db.as(BOB, () => db.query("insert into profiles default values"));
  await db.as(ALICE, async () => {
    course = (
      await one(
        db.query<{ id: string }>(
          "insert into courses (title, subject) values ('Mechanics', 'physics') returning id",
        ),
      )
    ).id;
    source = (
      await one(
        db.query<{ id: string }>(
          `insert into sources (course_id, kind, title, storage_path, page_count, embedding_model)
           values ($1, 'pdf', 'Chapter 3', 'user_alice/x.pdf', 12, 'gemini-embedding-2') returning id`,
          [course],
        ),
      )
    ).id;
    const insertChunk = (page: number, text: string, embedding: string) =>
      one(
        db.query<{ id: string }>(
          `insert into chunks (source_id, course_id, page, text, embedding)
           values ($1, $2, $3, $4, $5) returning id`,
          [source, course, page, text, embedding],
        ),
      );
    chunkA = (await insertChunk(4, "Newton's third law: forces come in pairs.", vec(0))).id;
    chunkB = (await insertChunk(9, "Friction opposes motion.", vec(10))).id;
  });
});

describe("courses RLS", () => {
  it("lets the owner build a course: concepts, prerequisites and sources", async () => {
    await db.as(ALICE, async () => {
      const [a, b] = await Promise.all(
        ["Forces", "Newton's laws"].map(async (title, i) =>
          one(
            db.query<{ id: string }>(
              `insert into concepts (course_id, title, summary, order_index, source_pages)
               values ($1, $2, '', $3, '{4}') returning id`,
              [course, title, i],
            ),
          ),
        ),
      );
      await db.query("insert into concept_edges (from_concept, to_concept) values ($1, $2)", [
        a?.id,
        b?.id,
      ]);
      await db.query("insert into concept_sources (concept_id, chunk_id) values ($1, $2)", [
        b?.id,
        chunkA,
      ]);
      await expect(
        db.query("insert into concept_edges (from_concept, to_concept) values ($1, $1)", [a?.id]),
      ).rejects.toThrow(/check/);
      const { rows } = await db.query("select * from concepts where course_id = $1", [course]);
      expect(rows).toHaveLength(2);
    });
  });

  it("hides one user's courses, sources, chunks and concepts from everyone else", async () => {
    await db.as(BOB, async () => {
      for (const table of ["courses", "sources", "chunks", "concepts", "concept_edges"]) {
        const { rows } = await db.query(`select * from ${table}`);
        expect(rows, table).toEqual([]);
      }
    });
    await db.as(null, async () => {
      await expect(db.query("select * from courses")).rejects.toThrow(/permission denied/);
    });
  });

  it("retrieves the nearest chunks of a course, and only the caller's own", async () => {
    const mine = await db.as(ALICE, () =>
      db.query<{ id: string; page: number; similarity: number }>(
        "select id, page, similarity from match_chunks($1, $2, 5)",
        [course, vec(10, 0.2)],
      ),
    );
    expect(mine.rows.map((r) => r.id)).toEqual([chunkB, chunkA]);
    expect(mine.rows[0]?.page).toBe(9);
    expect(mine.rows[0]?.similarity).toBeGreaterThan(0.9);

    // Bob passes Alice's course id: RLS still filters every row out.
    const theirs = await db.as(BOB, () =>
      db.query("select * from match_chunks($1, $2, 5)", [course, vec(10)]),
    );
    expect(theirs.rows).toEqual([]);
    await db.as(null, async () => {
      await expect(
        db.query("select * from match_chunks($1, $2, 5)", [course, vec(10)]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("refuses rows attached to someone else's course", async () => {
    await db.as(BOB, async () => {
      await expect(
        db.query(
          `insert into sources (course_id, kind, title, embedding_model)
           values ($1, 'text', 'sneaky', 'x')`,
          [course],
        ),
      ).rejects.toThrow(/foreign key|violates/);
      await expect(
        db.query(
          `insert into chunks (source_id, course_id, page, text, embedding)
           values ($1, $2, 1, 'sneaky', $3)`,
          [source, course, vec(0)],
        ),
      ).rejects.toThrow(/foreign key|violates/);
      // Spoofing the owner column is caught by the policy.
      await expect(
        db.query("insert into courses (user_id, title) values ($1, 'mine now')", [ALICE]),
      ).rejects.toThrow(/row-level security|violates/);
    });
  });

  it("only lets owners change the columns meant to change", async () => {
    await db.as(ALICE, async () => {
      await db.query(
        "update courses set status = 'review', exam_date = '2026-12-01' where id = $1",
        [course],
      );
      await expect(
        db.query("update courses set user_id = $1 where id = $2", [BOB, course]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query("update chunks set text = 'edited' where id = $1", [chunkA]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query("update courses set status = 'whatever' where id = $1", [course]),
      ).rejects.toThrow(/check/);
    });
  });

  it("keeps a notebook when its course is deleted, dropping only the link", async () => {
    await db.as(ALICE, async () => {
      const temp = await one(
        db.query<{ id: string }>("insert into courses (title) values ('Temp') returning id"),
      );
      const notebook = await one(
        db.query<{ id: string }>(
          "insert into notebooks (title, course_id) values ('Temp notes', $1) returning id",
          [temp.id],
        ),
      );
      await db.query("delete from courses where id = $1", [temp.id]);
      const after = await one(
        db.query<{ course_id: string | null }>("select course_id from notebooks where id = $1", [
          notebook.id,
        ]),
      );
      expect(after.course_id).toBeNull();
    });
    // A notebook can't be linked to someone else's course either.
    await db.as(BOB, async () => {
      await expect(
        db.query("insert into notebooks (title, course_id) values ('x', $1)", [course]),
      ).rejects.toThrow(/foreign key|violates/);
    });
  });

  it("keeps each user's uploads in their own storage folder", async () => {
    await db.as(ALICE, () =>
      db.query(
        "insert into storage.objects (bucket_id, name) values ('course-sources', 'user_alice/a.pdf')",
      ),
    );
    await db.as(ALICE, async () => {
      await expect(
        db.query(
          "insert into storage.objects (bucket_id, name) values ('course-sources', 'user_bob/a.pdf')",
        ),
      ).rejects.toThrow(/row-level security/);
    });
    const bobSees = await db.as(BOB, () => db.query("select * from storage.objects"));
    expect(bobSees.rows).toEqual([]);
    const bucket = await one(
      db.query<{ public: boolean; file_size_limit: number }>(
        "select public, file_size_limit from storage.buckets where id = 'course-sources'",
      ),
    );
    expect(bucket).toEqual({ public: false, file_size_limit: 15728640 });
  });
});
