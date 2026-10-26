import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

/** K3: where a clip goes in the notebook (migration 20261101000000_clip_destinations.sql). */

const ALICE = "user_alice";
const NODE = "0f1e2d3c-4b5a-4968-8776-655443322110";
let db: Db;

async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set role service_role");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

let next = 0;
function insert(destination: unknown) {
  next++;
  const id = `66666666-6666-4666-8666-${String(next).padStart(12, "0")}`;
  return db.query(
    `insert into clips (id, user_id, storage_path, width, height, pixel_ratio, source_app,
       captured_at, destination)
     values ($1, $2, $3, 100, 100, 1, 'msedge.exe', now(), $4)`,
    [id, ALICE, `${ALICE}/${id}.jpg`, destination === null ? null : JSON.stringify(destination)],
  );
}

beforeAll(async () => {
  db = await createTestDb();
  await db.as(ALICE, () => db.query("insert into profiles default values"));
});

describe("clip destinations", () => {
  it("keeps a node and its page", async () => {
    await asService(async () => {
      await insert(null);
      await insert({ nodeId: NODE, page: { kind: "from_screen" } });
      await insert({
        nodeId: NODE,
        page: { kind: "number", number: 3 },
        create: { title: "Ch 5" },
      });
    });
  });

  it.each([
    [{ nodeId: "physics", page: { kind: "from_screen" } }],
    [{ nodeId: NODE, page: { kind: "anywhere" } }],
    [{ nodeId: NODE }],
    [["not", "an", "object"]],
    [{ nodeId: NODE, page: { kind: "new" }, create: { title: "x".repeat(1300) } }],
  ])("refuses %j", async (destination) => {
    await expect(asService(() => insert(destination))).rejects.toThrow(/check constraint/);
  });

  it("can't be changed from the browser", async () => {
    await asService(() => insert({ nodeId: NODE, page: { kind: "new" } }));
    await expect(
      db.as(ALICE, () =>
        db.query(`update clips set destination = '{"nodeId":"${NODE}","page":{"kind":"new"}}'`),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
