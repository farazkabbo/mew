import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

const ALICE = "user_alice";
const BOB = "user_bob";

/** Node ids: one per name, so the tests read like the tree they build. */
const ID = {
  physics: "10000000-0000-4000-8000-000000000001",
  kinematics: "10000000-0000-4000-8000-000000000002",
  forces: "10000000-0000-4000-8000-000000000003",
  projectiles: "10000000-0000-4000-8000-000000000004",
  deeper: "10000000-0000-4000-8000-000000000005",
  chemistry: "10000000-0000-4000-8000-000000000006",
  bobs: "10000000-0000-4000-8000-000000000007",
};
const PAGE = "20000000-0000-4000-8000-000000000001";

type NodeInput = {
  id: string;
  title: string;
  parent_id?: string | null;
  position?: string;
  edited_at?: string;
  deleted_at?: string | null;
};
type Result = { id: string; status: string; node: Record<string, unknown> | null };

let db: Db;
let clock = Date.parse("2026-10-25T10:00:00Z");

/** A node as the device sends it, edited "now" (each call one second later). */
function node({ id, title, parent_id = null, position = "a0", ...rest }: NodeInput) {
  clock += 1000;
  return {
    id,
    parent_id,
    title,
    position,
    child_label: "Chapters",
    icon: null,
    color: null,
    course_id: null,
    deleted_at: rest.deleted_at ?? null,
    edited_at: rest.edited_at ?? new Date(clock).toISOString(),
  };
}

async function sync(user: string, nodes: object[], removed: string[] = []): Promise<Result[]> {
  return db.as(user, async () => {
    const { rows } = await db.query<{ results: Result[] }>(
      "select public.sync_notebook_tree($1::jsonb, $2::uuid[]) as results",
      [JSON.stringify(nodes), removed],
    );
    return rows[0]?.results ?? [];
  });
}

async function rows(user: string) {
  return db.as(user, async () => {
    const { rows: found } = await db.query<{
      id: string;
      title: string;
      parent_id: string | null;
      root_id: string;
      depth: number;
    }>("select id, title, parent_id, root_id, depth from notebooks order by depth, title");
    return found;
  });
}

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await db.exec("delete from notebooks");
});

describe("the notebook tree", () => {
  it("places nodes: depth and root are kept by the database, whatever is sent", async () => {
    const results = await sync(ALICE, [
      node({ id: ID.physics, title: "Physics" }),
      node({ id: ID.kinematics, title: "Kinematics", parent_id: ID.physics }),
      node({ id: ID.projectiles, title: "1.2 Projectiles", parent_id: ID.kinematics }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["saved", "saved", "saved"]);
    const tree = await rows(ALICE);
    expect(tree.map((r) => [r.title, r.depth, r.root_id])).toEqual([
      ["Physics", 0, ID.physics],
      ["Kinematics", 1, ID.physics],
      ["1.2 Projectiles", 2, ID.physics],
    ]);
  });

  it("refuses a fourth level, a loop, and a parent that isn't the caller's", async () => {
    await sync(ALICE, [
      node({ id: ID.physics, title: "Physics" }),
      node({ id: ID.kinematics, title: "Kinematics", parent_id: ID.physics }),
      node({ id: ID.projectiles, title: "Projectiles", parent_id: ID.kinematics }),
    ]);
    await sync(BOB, [node({ id: ID.bobs, title: "Bob's" })]);

    const [deep, loop, foreign] = await sync(ALICE, [
      node({ id: ID.deeper, title: "Too deep", parent_id: ID.projectiles }),
      node({ id: ID.physics, title: "Physics", parent_id: ID.kinematics }),
      node({ id: ID.chemistry, title: "Chemistry", parent_id: ID.bobs }),
    ]);
    expect(deep).toMatchObject({ status: "rejected", node: null });
    // The refused move hands back the server's copy, so the device can put it back.
    expect(loop).toMatchObject({ status: "rejected", node: { parent_id: null } });
    expect(foreign).toMatchObject({ status: "rejected", node: null });
    expect((await rows(ALICE)).map((r) => r.title)).toEqual([
      "Physics",
      "Kinematics",
      "Projectiles",
    ]);
  });

  it("moves a node with what's under it, unless that would go deeper than three levels", async () => {
    await sync(ALICE, [
      node({ id: ID.physics, title: "Physics" }),
      node({ id: ID.kinematics, title: "Kinematics", parent_id: ID.physics }),
      node({ id: ID.projectiles, title: "Projectiles", parent_id: ID.kinematics }),
      node({ id: ID.chemistry, title: "Chemistry" }),
      node({ id: ID.forces, title: "Forces", parent_id: ID.chemistry }),
    ]);

    // Kinematics (with its section) moves from Physics to Chemistry: both levels follow.
    const [moved] = await sync(ALICE, [
      node({ id: ID.kinematics, title: "Kinematics", parent_id: ID.chemistry }),
    ]);
    expect(moved?.status).toBe("saved");
    const placed = Object.fromEntries((await rows(ALICE)).map((r) => [r.title, r]));
    expect(placed.Kinematics).toMatchObject({ depth: 1, root_id: ID.chemistry });
    expect(placed.Projectiles).toMatchObject({ depth: 2, root_id: ID.chemistry });

    // Under Forces, its section would be a fourth level: refused, nothing moves.
    const [refused] = await sync(ALICE, [
      node({ id: ID.kinematics, title: "Kinematics", parent_id: ID.forces }),
    ]);
    expect(refused).toMatchObject({ status: "rejected", node: { parent_id: ID.chemistry } });
  });

  it("numbers a name that clashes with a sibling's, ignoring case and the trash", async () => {
    await sync(ALICE, [
      node({ id: ID.physics, title: "Physics" }),
      node({ id: ID.kinematics, title: "Kinematics", parent_id: ID.physics }),
    ]);
    const [clash, other, cousin] = await sync(ALICE, [
      node({ id: ID.chemistry, title: "physics" }),
      node({ id: ID.forces, title: "PHYSICS" }),
      // The same name under another parent is fine.
      node({ id: ID.projectiles, title: "Physics", parent_id: ID.physics }),
    ]);
    expect(clash).toMatchObject({ status: "renamed", node: { title: "physics 2" } });
    expect(other).toMatchObject({ status: "renamed", node: { title: "PHYSICS 3" } });
    expect(cousin).toMatchObject({ status: "saved", node: { title: "Physics" } });

    // A trashed node's name is free again.
    await sync(ALICE, [
      node({ id: ID.physics, title: "Physics", deleted_at: "2026-10-25T11:00:00Z" }),
    ]);
    const [reused] = await sync(ALICE, [node({ id: ID.deeper, title: "Physics" })]);
    expect(reused).toMatchObject({ status: "saved", node: { title: "Physics" } });
  });

  it("keeps the latest edit when two devices changed the same node", async () => {
    await sync(ALICE, [node({ id: ID.physics, title: "Physics" })]);
    const later = node({ id: ID.physics, title: "Physics (laptop)" });
    const earlier = node({
      id: ID.physics,
      title: "Physics (tablet)",
      edited_at: "2026-10-24T09:00:00Z",
    });
    expect((await sync(ALICE, [later]))[0]?.status).toBe("saved");
    const [stale] = await sync(ALICE, [earlier]);
    expect(stale).toMatchObject({ status: "stale", node: { title: "Physics (laptop)" } });
  });

  it("purges removed nodes with everything under them, pages included", async () => {
    await sync(ALICE, [
      node({ id: ID.physics, title: "Physics" }),
      node({ id: ID.kinematics, title: "Kinematics", parent_id: ID.physics }),
    ]);
    await db.as(ALICE, () =>
      db.query("insert into pages (id, notebook_id, index) values ($1, $2, 0)", [
        PAGE,
        ID.kinematics,
      ]),
    );
    await sync(ALICE, [], [ID.physics]);
    expect(await rows(ALICE)).toEqual([]);
    const pages = await db.as(ALICE, () => db.query("select id from pages"));
    expect(pages.rows).toEqual([]);
  });

  it("is private: nobody sees, renames, moves or deletes another student's nodes", async () => {
    await sync(ALICE, [node({ id: ID.physics, title: "Physics" })]);
    expect(await rows(BOB)).toEqual([]);
    // Bob sending Alice's id is refused, and her node is unchanged.
    const [taken] = await sync(BOB, [node({ id: ID.physics, title: "Mine now" })]);
    expect(taken).toMatchObject({ status: "rejected", node: null });
    await sync(BOB, [], [ID.physics]);
    expect((await rows(ALICE)).map((r) => r.title)).toEqual(["Physics"]);
    // And there's no other way in.
    await expect(
      db.as(null, () => db.query("select public.sync_notebook_tree('[]'::jsonb, '{}')")),
    ).rejects.toThrow(/permission denied/);
  });

  it("refuses an oversized sync", async () => {
    const many = Array.from({ length: 201 }, (_, i) =>
      node({ id: `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`, title: `N${i}` }),
    );
    await expect(sync(ALICE, many)).rejects.toThrow(/too many notebook changes/);
  });

  it("leaves a synced notebook's title and course to the tree when a page's lines sync", async () => {
    await sync(ALICE, [node({ id: ID.physics, title: "Physics" })]);
    await db.as(ALICE, () =>
      db.query("select public.sync_note_page($1, $2::jsonb, 0, '[]'::jsonb, '{}')", [
        PAGE,
        JSON.stringify({ id: ID.physics, title: "An old title", course_id: null }),
      ]),
    );
    expect((await rows(ALICE)).map((r) => r.title)).toEqual(["Physics"]);
  });

  it("numbers a notebook an older client's page sync creates under a taken name", async () => {
    await sync(ALICE, [node({ id: ID.physics, title: "Notes" })]);
    await db.as(ALICE, () =>
      db.query("select public.sync_note_page($1, $2::jsonb, 0, '[]'::jsonb, '{}')", [
        PAGE,
        JSON.stringify({ id: ID.chemistry, title: "notes", course_id: null }),
      ]),
    );
    expect((await rows(ALICE)).map((r) => r.title)).toEqual(["Notes", "notes 2"]);
  });
});
