import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

const ALICE = "user_alice";
const BOB = "user_bob";
const NOTEBOOK = "11111111-1111-4111-8111-111111111111";
const PAGE = "22222222-2222-4222-8222-222222222222";
const LINE = "33333333-3333-4333-8333-333333333333";

let db: Db;
let check: string;

async function one<T>(query: Promise<{ rows: T[] }>): Promise<T> {
  const row = (await query).rows[0];
  if (row === undefined) throw new Error("expected a row");
  return row;
}

function addFinding(checkId: string, page: string | null = PAGE) {
  return db.query<{ id: string }>(
    `insert into notes_findings (check_id, page_id, type, note_line_ids, note_quote,
       screen_snippet, question, confidence)
     values ($1, $2, 'difference', $3::uuid[], 'used up', 'not consumed', 'What does it say?', 0.9)
     returning id`,
    [checkId, page, [LINE]],
  );
}

beforeAll(async () => {
  db = await createTestDb();
  await db.as(BOB, () => db.query("insert into profiles default values"));
  await db.as(ALICE, () =>
    db.query("select sync_note_page($1, $2::jsonb, 0, $3::jsonb, '{}'::uuid[])", [
      PAGE,
      JSON.stringify({ id: NOTEBOOK, title: "Biology", course_id: null }),
      JSON.stringify([
        {
          id: LINE,
          line_index: 0,
          bbox: [0, 0, 100, 20],
          source: "ink",
          clip_id: null,
          text: "enzymes are used up",
          latex: null,
          confidence: 0.9,
          content_hash: "0a1b2c3d",
          embedding: null,
          embedding_model: null,
        },
      ]),
    ]),
  );
  check = (
    await db.as(ALICE, () =>
      one(
        db.query<{ id: string }>(
          `insert into notes_checks (scope, source_app, model_version, latency_ms)
           values ('{"kind": "notebook"}', 'msedge.exe', 'notes-compare.v1 gemini', 2100)
           returning id`,
        ),
      ),
    )
  ).id;
});

describe("notes checks and findings", () => {
  it("lets the owner record and read a check's findings, and nobody else", async () => {
    const finding = await db.as(ALICE, () => one(addFinding(check)));
    const mine = await db.as(ALICE, () => db.query("select id, status from notes_findings"));
    expect(mine.rows).toEqual([{ id: finding.id, status: "open" }]);
    expect((await db.as(BOB, () => db.query("select id from notes_findings"))).rows).toEqual([]);
    expect((await db.as(BOB, () => db.query("select id from notes_checks"))).rows).toEqual([]);
    await expect(db.as(null, () => db.query("select id from notes_findings"))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("never lets a finding be attached to another student's check or page", async () => {
    await expect(db.as(BOB, () => addFinding(check, null))).rejects.toThrow(/foreign key/);
    const bobs = await db.as(BOB, () =>
      one(
        db.query<{ id: string }>(
          `insert into notes_checks (scope, model_version, latency_ms)
           values ('{}', 'v1', 1) returning id`,
        ),
      ),
    );
    await expect(db.as(BOB, () => addFinding(bobs.id, PAGE))).rejects.toThrow(/foreign key/);
  });

  it("lets only the status change, and keeps it consistent with resolved_at", async () => {
    const finding = await db.as(ALICE, () => one(addFinding(check)));
    await db.as(ALICE, () =>
      db.query(
        "update notes_findings set status = 'resolved_fixed', resolved_at = now() where id = $1",
        [finding.id],
      ),
    );
    await expect(
      db.as(ALICE, () =>
        db.query(
          "update notes_findings set status = 'dismissed', resolved_at = null where id = $1",
          [finding.id],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
    for (const column of ["type", "question", "note_quote", "confidence", "check_id"]) {
      await expect(
        db.as(ALICE, () => db.query(`update notes_findings set ${column} = ${column}`)),
        column,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("refuses long snippets, so no screen text is kept beyond a quote", async () => {
    await expect(
      db.as(ALICE, () =>
        db.query(
          `insert into notes_findings (check_id, type, screen_snippet, confidence)
           values ($1, 'gap', $2, 0.8)`,
          [check, "x".repeat(201)],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("links a matched line to its source, and drops both with the page", async () => {
    const finding = await db.as(ALICE, () => one(addFinding(check)));
    await db.as(ALICE, () =>
      db.query(
        `insert into note_source_links (note_line_id, url, title, timestamp_sec,
           created_from_finding_id)
         values ($1, 'https://www.youtube.com/watch?v=abc&t=754', 'Enzymes lecture', 754, $2)`,
        [LINE, finding.id],
      ),
    );
    await expect(
      db.as(ALICE, () =>
        db.query("insert into note_source_links (note_line_id, url) values ($1, 'http://x.com')", [
          LINE,
        ]),
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.as(BOB, () =>
        db.query("insert into note_source_links (note_line_id, url) values ($1, 'https://x.com')", [
          LINE,
        ]),
      ),
    ).rejects.toThrow(/foreign key/);

    await db.as(ALICE, () => db.query("delete from pages where id = $1", [PAGE]));
    const left = await db.as(ALICE, () =>
      db.query(
        "select (select count(*) from notes_findings)::int as findings, (select count(*) from note_source_links)::int as links",
      ),
    );
    expect(left.rows).toEqual([{ findings: 0, links: 0 }]);
  });
});
