import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

/** K1 §2.2: which chapters a course's concepts belong to (20261107000000_concept_nodes). */

const ALICE = "user_alice";
const BOB = "user_bob";
const CHAPTER_1 = "11111111-1111-4111-8111-000000000001";
const CHAPTER_2 = "11111111-1111-4111-8111-000000000002";

let db: Db;
let course: string;
const concepts: Record<string, string> = {};

const zeros = `[${Array.from({ length: 768 }, () => 0).join(",")}]`;

async function id(query: Promise<{ rows: { id: string }[] }>): Promise<string> {
  const row = (await query).rows[0];
  if (!row) throw new Error("expected a row");
  return row.id;
}

beforeAll(async () => {
  db = await createTestDb();
  for (const user of [ALICE, BOB]) {
    await db.as(user, () => db.query("insert into profiles default values"));
  }
  await db.as(ALICE, async () => {
    course = await id(db.query("insert into courses (title) values ('Chemistry') returning id"));
    const source = await id(
      db.query(
        `insert into sources (course_id, kind, title, embedding_model)
         values ($1, 'pdf', 'chem.pdf', 'gemini-embedding-2') returning id`,
        [course],
      ),
    );
    const chunk = (page: number, node: string | null) =>
      id(
        db.query(
          `insert into chunks (source_id, course_id, page, text, embedding, notebook_node_id)
           values ($1, $2, $3, 'text', $4, $5) returning id`,
          [source, course, page, zeros, node],
        ),
      );
    const [first, second, loose] = [
      await chunk(1, CHAPTER_1),
      await chunk(9, CHAPTER_2),
      await chunk(12, null),
    ];
    for (const [title, chunks] of [
      ["Atoms", [first]],
      ["Bonds", [first, second]],
      ["Course-wide", [loose]],
    ] as const) {
      concepts[title] = await id(
        db.query(
          `insert into concepts (course_id, title, summary, order_index, source_pages)
           values ($1, $2, '', 0, '{}') returning id`,
          [course, title],
        ),
      );
      for (const chunkId of chunks) {
        await db.query("insert into concept_sources (concept_id, chunk_id) values ($1, $2)", [
          concepts[title],
          chunkId,
        ]);
      }
    }
  });
});

const nodes = (user: string | null) =>
  db.as(user, () =>
    db.query<{ concept_id: string; notebook_node_id: string }>(
      "select * from concept_nodes($1) order by notebook_node_id, concept_id",
      [course],
    ),
  );

describe("concept_nodes", () => {
  it("gives each concept the chapters its passages went to, once each", async () => {
    const { rows } = await nodes(ALICE);
    expect(rows).toHaveLength(3);
    const of = (title: string) =>
      rows.filter((r) => r.concept_id === concepts[title]).map((r) => r.notebook_node_id);
    expect(of("Atoms")).toEqual([CHAPTER_1]);
    expect(of("Bonds").sort()).toEqual([CHAPTER_1, CHAPTER_2]);
    expect(of("Course-wide")).toEqual([]); // its passage isn't in any chapter
  });

  it("shows another student nothing, whatever course they ask about", async () => {
    expect((await nodes(BOB)).rows).toEqual([]);
  });

  it("can't be called signed out", async () => {
    await expect(nodes(null)).rejects.toThrow(/permission denied/);
  });
});
