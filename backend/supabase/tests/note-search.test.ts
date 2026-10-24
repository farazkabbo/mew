import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

const ALICE = "user_alice";
const BOB = "user_bob";

const BIOLOGY = "11111111-1111-4111-8111-111111111111";
const HISTORY = "11111111-1111-4111-8111-222222222222";
const BIO_PAGE = "22222222-2222-4222-8222-111111111111";
const HIST_PAGE = "22222222-2222-4222-8222-222222222222";
const BOB_NOTEBOOK = "11111111-1111-4111-8111-333333333333";
const BOB_PAGE = "22222222-2222-4222-8222-333333333333";

let db: Db;

/** A 768-dimension vector: 1 at `hot` (and `also`, if given), 0 elsewhere. */
function vector(hot: number, also?: number): string {
  return `[${Array.from({ length: 768 }, (_, i) => (i === hot || i === also ? 1 : 0)).join(",")}]`;
}

function line(id: string, text: string, index: number, embedding: string) {
  return {
    id,
    line_index: index,
    bbox: [0, index * 30, 200, 24],
    source: "ink",
    clip_id: null,
    text,
    latex: null,
    confidence: 0.9,
    content_hash: "0a1b2c3d",
    embedding,
    embedding_model: "test-model",
  };
}

async function sync(user: string, page: string, notebook: string, lines: unknown[]) {
  await db.as(user, () =>
    db.query("select sync_note_page($1, $2::jsonb, 0, $3::jsonb, '{}'::uuid[])", [
      page,
      JSON.stringify({ id: notebook, title: "Notes", course_id: null }),
      JSON.stringify(lines),
    ]),
  );
}

type Found = { id: string; similarity: number | null; word_rank: number | null };

function search(
  user: string | null,
  owner: string,
  {
    query = null,
    terms = [],
    notebooks = null,
  }: { query?: string | null; terms?: string[]; notebooks?: string[] | null },
) {
  return db.as(user, async () => {
    const { rows } = await db.query<Found>(
      `select id, similarity, word_rank
       from match_note_lines($1, $2::extensions.vector, 'test-model', $3::text[], $4::uuid[],
         null, 40)
       order by id`,
      [owner, query, terms, notebooks],
    );
    return rows;
  });
}

const ENZYMES = "33333333-3333-4333-8333-000000000001";
const USED_UP = "33333333-3333-4333-8333-000000000002";
const TREATY = "33333333-3333-4333-8333-000000000003";
const BOBS = "33333333-3333-4333-8333-000000000004";

beforeAll(async () => {
  db = await createTestDb();
  await sync(ALICE, BIO_PAGE, BIOLOGY, [
    line(ENZYMES, "enzymes lower activation energy", 0, vector(1)),
    line(USED_UP, "they are used up in the reaction", 1, vector(2)),
  ]);
  await sync(ALICE, HIST_PAGE, HISTORY, [
    line(TREATY, "Treaty of Versailles signed 1919", 0, vector(3)),
  ]);
  await sync(BOB, BOB_PAGE, BOB_NOTEBOOK, [line(BOBS, "enzymes are proteins", 0, vector(1))]);
});

describe("match_note_lines", () => {
  it("finds lines by meaning, nearest first, with their similarity", async () => {
    const found = await search(ALICE, ALICE, { query: vector(1) });
    expect(found.find((f) => f.id === ENZYMES)?.similarity).toBeCloseTo(1);
    expect(found.find((f) => f.id === TREATY)?.similarity).toBeCloseTo(0);
  });

  it("finds lines by word, in any of the terms", async () => {
    const found = await search(ALICE, ALICE, { terms: ["activation energy", "Versailles"] });
    expect(found.map((f) => f.id).sort()).toEqual([ENZYMES, TREATY].sort());
    expect(found.every((f) => (f.word_rank ?? 0) > 0 && f.similarity === null)).toBe(true);
  });

  it("keeps to the notebooks in scope", async () => {
    const found = await search(ALICE, ALICE, { query: vector(3), notebooks: [BIOLOGY] });
    expect(found.map((f) => f.id).sort()).toEqual([ENZYMES, USED_UP].sort());
  });

  it("never returns another student's lines, whoever is named", async () => {
    expect((await search(ALICE, ALICE, { terms: ["proteins"] })).map((f) => f.id)).toEqual([]);
    // Alice naming Bob gets nothing: RLS applies as well as the filter.
    expect(await search(ALICE, BOB, { query: vector(1), terms: ["enzymes"] })).toEqual([]);
  });

  it("leaves out the lines of the clip being checked", async () => {
    const clip = "77777777-7777-4777-8777-777777777777";
    const slide = "33333333-3333-4333-8333-000000000009";
    await db.exec("set role service_role");
    try {
      await db.query(
        `insert into clips (id, user_id, storage_path, width, height, pixel_ratio, source_app,
           annotations, ocr_text, captured_at)
         values ($1, $2, $3, 100, 100, 1, 'msedge.exe', '[]', 'Enzymes', now())`,
        [clip, ALICE, `${ALICE}/${clip}.jpg`],
      );
    } finally {
      await db.exec("reset role");
    }
    await sync(ALICE, BIO_PAGE, BIOLOGY, [
      { ...line(slide, "Enzymes are not consumed", 5, vector(1)), source: "clip", clip_id: clip },
    ]);
    const withClip = await db.as(ALICE, () =>
      db.query<{ id: string }>(
        `select id from match_note_lines($1, null, 'test-model', $2::text[], null, $3, 40)`,
        [ALICE, ["enzymes"], clip],
      ),
    );
    expect(withClip.rows.map((r) => r.id)).not.toContain(slide);
    expect(withClip.rows.map((r) => r.id)).toContain(ENZYMES);
  });

  it("treats search terms as plain words, never as query syntax", async () => {
    for (const term of ["a & !b", "enzymes | (", "':*", "\\", "!!!", ""]) {
      await expect(search(ALICE, ALICE, { terms: [term] }), term).resolves.toBeDefined();
    }
  });

  it("lets the API service search for a device's owner, and nobody anonymous", async () => {
    await db.exec("set role service_role");
    try {
      const { rows } = await db.query<{ id: string }>(
        "select id from match_note_lines($1, null, 'test-model', $2::text[], null, null, 40)",
        [BOB, ["enzymes"]],
      );
      expect(rows.map((r) => r.id)).toEqual([BOBS]);
    } finally {
      await db.exec("reset role");
    }
    await expect(search(null, ALICE, { terms: ["enzymes"] })).rejects.toThrow(/permission denied/);
  });
});
