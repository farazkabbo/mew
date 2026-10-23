import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

const ALICE = "user_alice";
const BOB = "user_bob";

const NOTEBOOK = "11111111-1111-4111-8111-111111111111";
const PAGE = "22222222-2222-4222-8222-222222222222";
const LINE_A = "33333333-3333-4333-8333-333333333333";
const LINE_B = "44444444-4444-4444-8444-444444444444";
const BOB_NOTEBOOK = "55555555-5555-4555-8555-555555555555";
const BOB_PAGE = "66666666-6666-4666-8666-666666666666";
const CLIP = "77777777-7777-4777-8777-777777777777";
const UNKNOWN_COURSE = "88888888-8888-4888-8888-888888888888";

let db: Db;

/** A 768-dimension vector in pgvector's text form: a 1 at `hot`, 0 elsewhere. */
function vector(hot: number): string {
  return `[${Array.from({ length: 768 }, (_, i) => (i === hot ? 1 : 0)).join(",")}]`;
}

type LineInput = {
  id: string;
  text: string;
  line_index?: number;
  source?: "ink" | "clip";
  clip_id?: string | null;
  embedding?: string | null;
  keep_embedding?: boolean;
};

function line({ id, text, line_index = 0, source = "ink", clip_id = null, ...rest }: LineInput) {
  const embedding = rest.embedding === undefined ? vector(line_index) : rest.embedding;
  return {
    id,
    line_index,
    bbox: [10, 20 + 30 * line_index, 200, 24],
    source,
    clip_id,
    text,
    latex: null,
    confidence: 0.9,
    content_hash: "0a1b2c3d",
    embedding,
    embedding_model: embedding === null ? null : "lexical-hash-v1",
    keep_embedding: rest.keep_embedding ?? false,
  };
}

function sync(
  page: string,
  notebook: { id: string; title?: string; course_id?: string | null },
  lines: ReturnType<typeof line>[],
  removed: string[] = [],
  index = 0,
) {
  return db.query("select sync_note_page($1, $2::jsonb, $3, $4::jsonb, $5::uuid[])", [
    page,
    JSON.stringify({ title: "Biology", course_id: null, ...notebook }),
    index,
    JSON.stringify(lines),
    removed,
  ]);
}

async function linesOf(user: string) {
  const { rows } = await db.as(user, () =>
    db.query<{ id: string; text: string; line_index: number; has_embedding: boolean }>(
      `select id, text, line_index, embedding is not null as has_embedding
       from note_lines order by line_index`,
    ),
  );
  return rows;
}

beforeAll(async () => {
  db = await createTestDb();
});

// As the database owner: a clean slate for every test.
beforeEach(async () => {
  await db.exec("delete from note_lines; delete from pages; delete from notebooks");
  await db.exec("delete from clips; delete from profiles");
});

describe("sync_note_page", () => {
  it("mirrors the notebook and page and stores the lines, searchable by word", async () => {
    await db.as(ALICE, () =>
      sync(PAGE, { id: NOTEBOOK }, [
        line({ id: LINE_A, text: "enzymes lower activation energy", line_index: 0 }),
        line({ id: LINE_B, text: "not used up", line_index: 1 }),
      ]),
    );

    expect(await linesOf(ALICE)).toEqual([
      { id: LINE_A, text: "enzymes lower activation energy", line_index: 0, has_embedding: true },
      { id: LINE_B, text: "not used up", line_index: 1, has_embedding: true },
    ]);
    const mirrored = await db.as(ALICE, () =>
      db.query("select n.title, p.index from pages p join notebooks n on n.id = p.notebook_id"),
    );
    expect(mirrored.rows).toEqual([{ title: "Biology", index: 0 }]);
    const found = await db.as(ALICE, () =>
      db.query("select id from note_lines where search @@ to_tsquery('simple', 'activation')"),
    );
    expect(found.rows).toEqual([{ id: LINE_A }]);
  });

  it("keeps the embedding of a line whose text didn't change, and replaces a changed one", async () => {
    await db.as(ALICE, () =>
      sync(PAGE, { id: NOTEBOOK }, [line({ id: LINE_A, text: "first", embedding: vector(5) })]),
    );
    await db.as(ALICE, () =>
      sync(PAGE, { id: NOTEBOOK }, [
        line({ id: LINE_A, text: "first", line_index: 3, embedding: null, keep_embedding: true }),
      ]),
    );
    const kept = await db.as(ALICE, () =>
      db.query<{ line_index: number; hot: number }>(
        `select line_index, (embedding operator(extensions.<=>) $1::extensions.vector) as hot
         from note_lines`,
        [vector(5)],
      ),
    );
    expect(kept.rows).toEqual([{ line_index: 3, hot: 0 }]);

    await db.as(ALICE, () =>
      sync(PAGE, { id: NOTEBOOK }, [line({ id: LINE_A, text: "second", embedding: null })]),
    );
    expect(await linesOf(ALICE)).toEqual([
      { id: LINE_A, text: "second", line_index: 0, has_embedding: false },
    ]);
  });

  it("removes lines that are gone, only on the page being synced", async () => {
    await db.as(ALICE, () =>
      sync(PAGE, { id: NOTEBOOK }, [
        line({ id: LINE_A, text: "a", line_index: 0 }),
        line({ id: LINE_B, text: "b", line_index: 1 }),
      ]),
    );
    await db.as(ALICE, () => sync(PAGE, { id: NOTEBOOK }, [], [LINE_B]));
    expect((await linesOf(ALICE)).map((l) => l.id)).toEqual([LINE_A]);
  });

  it("refuses empty or oversized text and too many lines at once", async () => {
    await expect(
      db.as(ALICE, () => sync(PAGE, { id: NOTEBOOK }, [line({ id: LINE_A, text: "" })])),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.as(ALICE, () =>
        sync(PAGE, { id: NOTEBOOK }, [line({ id: LINE_A, text: "x".repeat(301) })]),
      ),
    ).rejects.toThrow(/check constraint/);
    const many = Array.from({ length: 201 }, (_, i) =>
      line({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, text: "x" }),
    );
    await expect(db.as(ALICE, () => sync(PAGE, { id: NOTEBOOK }, many))).rejects.toThrow(
      /too many lines/,
    );
  });

  it("leaves out a course the caller can't see instead of failing", async () => {
    await db.as(ALICE, () =>
      sync(PAGE, { id: NOTEBOOK, course_id: UNKNOWN_COURSE }, [line({ id: LINE_A, text: "a" })]),
    );
    const notebook = await db.as(ALICE, () => db.query("select course_id from notebooks"));
    expect(notebook.rows).toEqual([{ course_id: null }]);
  });

  it("only takes clip lines from the caller's own clips", async () => {
    await db.exec("set role service_role");
    try {
      await db.query("insert into profiles (id) values ($1)", [BOB]);
      await db.query(
        `insert into clips (id, user_id, storage_path, width, height, pixel_ratio, source_app,
           annotations, ocr_text, captured_at)
         values ($1, $2, $3, 100, 100, 1, 'msedge.exe', '[]', 'Slide', now())`,
        [CLIP, BOB, `${BOB}/${CLIP}.jpg`],
      );
    } finally {
      await db.exec("reset role");
    }
    await expect(
      db.as(ALICE, () =>
        sync(PAGE, { id: NOTEBOOK }, [
          line({ id: LINE_A, text: "Slide", source: "clip", clip_id: CLIP }),
        ]),
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(
      db.as(ALICE, () =>
        sync(PAGE, { id: NOTEBOOK }, [line({ id: LINE_A, text: "Slide", source: "clip" })]),
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe("isolation between users", () => {
  beforeEach(async () => {
    await db.as(ALICE, () =>
      sync(PAGE, { id: NOTEBOOK }, [line({ id: LINE_A, text: "alice's note" })]),
    );
  });

  it("hides other users' lines", async () => {
    expect(await linesOf(BOB)).toEqual([]);
  });

  it("doesn't let a user write into another user's notebook", async () => {
    await expect(
      db.as(BOB, () => sync(BOB_PAGE, { id: NOTEBOOK }, [line({ id: LINE_B, text: "bob" })])),
    ).rejects.toThrow();
    const title = await db.as(ALICE, () => db.query("select title from notebooks"));
    expect(title.rows).toEqual([{ title: "Biology" }]);
  });

  it("never overwrites or moves another user's line (the clashing line is skipped)", async () => {
    await db.as(BOB, () =>
      sync(BOB_PAGE, { id: BOB_NOTEBOOK }, [line({ id: LINE_A, text: "overwritten" })]),
    );
    expect((await linesOf(ALICE)).map((l) => l.text)).toEqual(["alice's note"]);
    expect(await linesOf(BOB)).toEqual([]);
  });

  it("doesn't let a user delete another user's lines", async () => {
    await db.as(BOB, () => db.query("delete from note_lines"));
    await db.as(BOB, () => sync(BOB_PAGE, { id: BOB_NOTEBOOK }, [], [LINE_A]));
    expect(await linesOf(ALICE)).toHaveLength(1);
  });

  it("denies anonymous access to the table and the function", async () => {
    await expect(db.as(null, () => db.query("select id from note_lines"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.as(null, () => sync(PAGE, { id: NOTEBOOK }, []))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("forbids rewriting a line's id, owner or page", async () => {
    for (const column of ["id", "user_id", "page_id", "source"]) {
      await expect(
        db.as(ALICE, () => db.query(`update note_lines set ${column} = ${column}`)),
        column,
      ).rejects.toThrow(/permission denied/);
    }
  });
});

describe("the notes_index setting", () => {
  it("refuses new or changed lines while it's off, and still allows deleting them", async () => {
    await db.as(ALICE, () =>
      sync(PAGE, { id: NOTEBOOK }, [line({ id: LINE_A, text: "kept for now" })]),
    );
    await db.as(ALICE, () =>
      db.query(`update profiles set settings = '{"notes_index": false}'::jsonb`),
    );

    await expect(
      db.as(ALICE, () => sync(PAGE, { id: NOTEBOOK }, [line({ id: LINE_B, text: "new" })])),
    ).rejects.toThrow(/row-level security/);
    await expect(
      db.as(ALICE, () => db.query("update note_lines set text = 'changed'")),
    ).rejects.toThrow(/row-level security/);

    await db.as(ALICE, () => db.query("delete from note_lines"));
    expect(await linesOf(ALICE)).toEqual([]);
  });

  it("only accepts a boolean", async () => {
    await db.as(ALICE, () => db.query("insert into profiles default values"));
    await expect(
      db.as(ALICE, () => db.query(`update profiles set settings = '{"notes_index": "no"}'`)),
    ).rejects.toThrow(/notes_index/);
  });
});

describe("cascades", () => {
  it("deletes a page's lines with the page, and every line with the notebook", async () => {
    await db.as(ALICE, () => sync(PAGE, { id: NOTEBOOK }, [line({ id: LINE_A, text: "a" })]));
    await db.as(ALICE, () => db.query("delete from pages where id = $1", [PAGE]));
    expect(await linesOf(ALICE)).toEqual([]);

    await db.as(ALICE, () => sync(PAGE, { id: NOTEBOOK }, [line({ id: LINE_A, text: "a" })]));
    await db.as(ALICE, () => db.query("delete from notebooks"));
    expect(await linesOf(ALICE)).toEqual([]);
  });
});
