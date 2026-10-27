import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

/** S5 skills and S6 quiz cards (20261108000000_skills, 20261109000000_screen_quiz). */

const ALICE = "user_alice";
const BOB = "user_bob";
const CARD = JSON.stringify({ due: "2026-10-30T00:00:00Z", stability: 3, reps: 1, state: 2 });
const STEPS = JSON.stringify([
  {
    instruction: "Click Insert.",
    successCondition: "The Insert tab is selected.",
    hint: "Look at the top.",
    explicit: "Click the Insert tab.",
    hints: 1,
    checks: 1,
    misses: 0,
    outcome: "checked",
  },
]);

let db: Db;
let walkthrough: string;
let skill: string;

async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set role service_role");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

async function one<T>(query: Promise<{ rows: T[] }>): Promise<T> {
  const row = (await query).rows[0];
  if (row === undefined) throw new Error("expected a row");
  return row;
}

const addSkill = (user: string, key: string, extra: Record<string, unknown> = {}) => {
  const values = {
    user_id: user,
    title: "Pivot tables",
    app_exe_name: "excel.exe",
    key,
    fsrs_state: CARD,
    due_at: "2026-10-30T00:00:00Z",
    ...extra,
  };
  const names = Object.keys(values);
  return db.query<{ id: string }>(
    `insert into skills (${names.join(", ")})
     values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(values),
  );
};

const addEvidence = (fields: Record<string, unknown>) => {
  const values = {
    user_id: ALICE,
    skill_id: skill,
    kind: "guided",
    evidence: "with_hint",
    ...fields,
  };
  const names = Object.keys(values);
  return db.query(
    `insert into skill_evidence (${names.join(", ")})
     values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(values),
  );
};

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
  await db.as(BOB, () => db.query("insert into profiles default values"));
  walkthrough = (
    await one(
      asService(() =>
        db.query<{ id: string }>(
          `insert into walkthroughs (user_id, title, goal, app_exe_name, steps)
           values ($1, 'Pivot tables', 'teach me pivot tables', 'excel.exe', $2) returning id`,
          [ALICE, STEPS],
        ),
      ),
    )
  ).id;
  skill = (
    await one(
      asService(() =>
        addSkill(ALICE, "pivot tables|excel.exe", { last_walkthrough_id: walkthrough }),
      ),
    )
  ).id;
});

describe("skills (S5)", () => {
  it("keep one per task and app, read by their owner only", async () => {
    await expect(asService(() => addSkill(ALICE, "pivot tables|excel.exe"))).rejects.toThrow(
      /unique/,
    );
    const mine = await db.as(ALICE, () => db.query<{ title: string }>("select title from skills"));
    expect(mine.rows.map((r) => r.title)).toEqual(["Pivot tables"]);
    expect((await db.as(BOB, () => db.query("select * from skills"))).rows).toEqual([]);
  });

  it("are written by the API service, never by a browser", async () => {
    await expect(db.as(ALICE, () => addSkill(ALICE, "charts|excel.exe"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      db.as(ALICE, () => db.query("update skills set due_at = now() where id = $1", [skill])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.as(ALICE, () => addEvidence({ evidence: "independent", kind: "recheck" })),
    ).rejects.toThrow(/permission denied/);
  });

  it("never take a guided walkthrough as independent: only a re-check is", async () => {
    await asService(() => addEvidence({ walkthrough_id: walkthrough }));
    await asService(() => addEvidence({ evidence: "after_explanation", hints: 3 }));
    await asService(() => addEvidence({ kind: "recheck", evidence: "independent" }));
    await asService(() => addEvidence({ kind: "recheck", evidence: "not_yet" }));
    await expect(asService(() => addEvidence({ evidence: "independent" }))).rejects.toThrow(
      /check constraint/,
    );
    const rows = await db.as(ALICE, () => db.query("select evidence from skill_evidence"));
    expect(rows.rows).toHaveLength(4);
    expect((await db.as(BOB, () => db.query("select * from skill_evidence"))).rows).toEqual([]);
  });

  it("can't point at another student's walkthrough or skill", async () => {
    await expect(
      asService(() => addSkill(BOB, "x|excel.exe", { last_walkthrough_id: walkthrough })),
    ).rejects.toThrow(/foreign key/);
    await expect(asService(() => addEvidence({ user_id: BOB }))).rejects.toThrow(/foreign key/);
    await expect(
      asService(() =>
        db.query("update walkthroughs set skill_id = $1 where user_id = $2", [skill, BOB]),
      ),
    ).resolves.toBeDefined(); // no row of Bob's to change
  });

  it("can be deleted by their owner, with their evidence", async () => {
    await asService(() =>
      db.query("update walkthroughs set skill_id = $1, kind = 'recheck' where id = $2", [
        skill,
        walkthrough,
      ]),
    );
    await db.as(ALICE, () => db.query("delete from skills where id = $1", [skill]));
    expect((await db.as(ALICE, () => db.query("select * from skill_evidence"))).rows).toEqual([]);
    const kept = await one(
      db.as(ALICE, () =>
        db.query<{ skill_id: string | null }>("select skill_id from walkthroughs where id = $1", [
          walkthrough,
        ]),
      ),
    );
    expect(kept.skill_id).toBeNull(); // the walkthrough itself stays
  });
});

describe("quiz cards (S6)", () => {
  const quizCard = (fields: Record<string, unknown> = {}) => {
    const values = {
      user_id: ALICE,
      origin: "screen_quiz",
      clip_id: null,
      prompt: "What does a pivot table summarise?",
      kind: "short",
      answer_key: "Rows of data, grouped and totalled.",
      source_title: "Sales.xlsx - Excel",
      source_app: "excel.exe",
      status: "active",
      due_at: "2026-10-30T00:00:00Z",
      ...fields,
    };
    const names = Object.keys(values);
    return db.query(
      `insert into moment_checks (${names.join(", ")})
       values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(values),
    );
  };

  it("are moment checks without a moment, with where they came from", async () => {
    await asService(() => quizCard());
    const { rows } = await db.as(ALICE, () =>
      db.query<{ origin: string; clip_id: string | null }>(
        "select origin, clip_id from moment_checks",
      ),
    );
    expect(rows).toEqual([{ origin: "screen_quiz", clip_id: null }]);
  });

  it.each([
    [{ origin: "moment" }], // a moment's card needs its moment
    [{ origin: "elsewhere" }],
    [{ source_app: "not an app" }],
    [{ source_title: "" }],
  ])("refuses %j", async (fields) => {
    await expect(asService(() => quizCard(fields))).rejects.toThrow(/check constraint/);
  });
});
