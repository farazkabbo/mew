import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

/** K8: notebook subjects, filing memory, corrections and moment checks (20261104000000_moments). */

const ALICE = "user_alice";
const BOB = "user_bob";
const PHYSICS = "0f1e2d3c-4b5a-4968-8776-655443322110";
const KINEMATICS = "0f1e2d3c-4b5a-4968-8776-655443322111";
const BOBS = "0f1e2d3c-4b5a-4968-8776-655443322119";
const CLIP = "66666666-6666-4666-8666-000000000001";
let db: Db;

async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set role service_role");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

const sync = (user: string, nodes: object[]) =>
  db.as(user, () =>
    db.query<{ sync_notebook_tree: { status: string; node: { subject: string | null } }[] }>(
      "select public.sync_notebook_tree($1::jsonb)",
      [JSON.stringify(nodes)],
    ),
  );

const node = (id: string, title: string, extra: object = {}) => ({
  id,
  parent_id: null,
  title,
  position: "a0",
  child_label: "Chapters",
  icon: null,
  color: null,
  course_id: null,
  deleted_at: null,
  edited_at: new Date().toISOString(),
  ...extra,
});

const check = (fields: Record<string, unknown> = {}) =>
  db.query(
    `insert into moment_checks (user_id, clip_id, node_id, prompt, kind, choices, answer_key,
       concept_hints, status, fsrs_state, due_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      fields.user_id ?? ALICE,
      fields.clip_id ?? CLIP,
      fields.node_id ?? KINEMATICS,
      fields.prompt ?? "Why is the slope of this graph the acceleration?",
      fields.kind ?? "short",
      JSON.stringify(fields.choices ?? []),
      fields.answer_key ?? "Acceleration is the rate of change of velocity.",
      fields.concept_hints ?? ["acceleration"],
      fields.status ?? "active",
      JSON.stringify({ due: "2026-10-27T00:00:00Z" }),
      "due_at" in fields ? fields.due_at : "2026-10-27T00:00:00Z",
    ],
  );

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
  await db.as(BOB, () => db.query("insert into profiles default values"));
  await sync(ALICE, [
    node(PHYSICS, "Physics", { subject: "physics" }),
    node(KINEMATICS, "Chapter 3 · Kinematics", { parent_id: PHYSICS }),
  ]);
  await sync(BOB, [node(BOBS, "Bob's notebook")]);
  await asService(() =>
    db.query(
      `insert into clips (id, user_id, storage_path, width, height, pixel_ratio, source_app,
         captured_at)
       values ($1, $2, $3, 100, 100, 1, 'msedge.exe', now())`,
      [CLIP, ALICE, `${ALICE}/${CLIP}.jpg`],
    ),
  );
});

describe("a notebook's subject (K8)", () => {
  it("is synced with the tree, and must be one of the subjects", async () => {
    const { rows } = await db.as(ALICE, () =>
      db.query<{ subject: string | null }>("select subject from notebooks where id = $1", [
        PHYSICS,
      ]),
    );
    expect(rows[0]?.subject).toBe("physics");

    const [result] =
      (await sync(ALICE, [node(PHYSICS, "Physics", { subject: "astrology" })])).rows[0]
        ?.sync_notebook_tree ?? [];
    expect(result?.status).toBe("rejected");
    expect(result?.node.subject).toBe("physics");
  });
});

describe("filing memory and corrections", () => {
  it("lets the student record where a source's moments go, on their own notebooks only", async () => {
    await db.as(ALICE, async () => {
      await db.query(
        "insert into filing_memory (source_key, node_id, corrected) values ('youtube:abc', $1, true)",
        [KINEMATICS],
      );
      await db.query(
        "insert into filing_corrections (from_node_id, to_node_id, hints) values ($1, $2, $3)",
        [PHYSICS, KINEMATICS, ["projectile motion"]],
      );
    });
    // Bob can't point a source at Alice's notebook, nor see hers.
    await expect(
      db.as(BOB, () =>
        db.query("insert into filing_memory (source_key, node_id) values ('youtube:x', $1)", [
          KINEMATICS,
        ]),
      ),
    ).rejects.toThrow(/foreign key/);
    const seen = await db.as(BOB, () => db.query("select * from filing_memory"));
    expect(seen.rows).toEqual([]);
    // Nor give the row to someone else.
    await expect(
      db.as(ALICE, () =>
        db.query(
          "insert into filing_memory (user_id, source_key, node_id) values ($1, 'web:x', $2)",
          [BOB, KINEMATICS],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("goes when the notebook does", async () => {
    await sync(ALICE, [node("0f1e2d3c-4b5a-4968-8776-655443322112", "Chemistry")]);
    await db.as(ALICE, () =>
      db.query("insert into filing_memory (source_key, node_id) values ('pdf:chem.pdf', $1)", [
        "0f1e2d3c-4b5a-4968-8776-655443322112",
      ]),
    );
    await db.as(ALICE, () =>
      db.query("select public.sync_notebook_tree('[]'::jsonb, $1)", [
        ["0f1e2d3c-4b5a-4968-8776-655443322112"],
      ]),
    );
    const { rows } = await db.as(ALICE, () =>
      db.query("select * from filing_memory where source_key = 'pdf:chem.pdf'"),
    );
    expect(rows).toEqual([]);
  });
});

describe("moment checks", () => {
  it("are made by the API service, read and scheduled by their owner only", async () => {
    await asService(() => check());
    const mine = await db.as(ALICE, () =>
      db.query<{ id: string; prompt: string }>("select id, prompt from moment_checks"),
    );
    expect(mine.rows).toHaveLength(1);
    const id = mine.rows[0]?.id;
    expect((await db.as(BOB, () => db.query("select * from moment_checks"))).rows).toEqual([]);

    // The owner answers (the schedule changes) but can't rewrite the question or its key.
    await db.as(ALICE, () =>
      db.query(
        "update moment_checks set due_at = now() + interval '3 days', reps = 1 where id = $1",
        [id],
      ),
    );
    await expect(
      db.as(ALICE, () =>
        db.query("update moment_checks set answer_key = 'anything' where id = $1", [id]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(db.as(ALICE, () => check())).rejects.toThrow(/permission denied/);
  });

  it.each([
    [{ kind: "essay" }],
    [{ prompt: "" }],
    [{ choices: ["a", "b", "c", "d", "e"] }],
    [{ concept_hints: ["a", "b", "c", "d", "e", "f"] }],
    [{ status: "active", due_at: null }],
    [{ status: "queued" }], // a queued check has no due date yet
  ])("refuses %j", async (fields) => {
    await expect(asService(() => check(fields))).rejects.toThrow(/check constraint/);
  });

  it("can't point at another student's moment", async () => {
    await expect(asService(() => check({ user_id: BOB }))).rejects.toThrow(/foreign key/);
  });

  it("go with their moment", async () => {
    await asService(() => db.query("delete from clips where id = $1", [CLIP]));
    const { rows } = await asService(() => db.query("select * from moment_checks"));
    expect(rows).toEqual([]);
  });
});

describe("answering a moment's check", () => {
  it("is an attempt source, and the setting is a boolean", async () => {
    const set = (settings: object) =>
      db.as(ALICE, () =>
        db.query("update profiles set settings = $1 where id = $2", [
          JSON.stringify(settings),
          ALICE,
        ]),
      );
    await set({ quiz_saved_moments: false });
    await expect(set({ quiz_saved_moments: "sometimes" })).rejects.toThrow(/check constraint/);
    const { rows } = await db.query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'attempts_source_check'",
    );
    expect(rows[0]?.def).toContain("moment_check");
  });
});
