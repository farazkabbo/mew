import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type Db } from "./harness";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

describe("indexes", () => {
  // Deleting a parent row looks up its children through the foreign key's columns. Without an
  // index starting with the key's first column, every such delete scans the child table.
  it("covers the first column of every foreign key in public", async () => {
    const { rows } = await db.query<{ constraint_name: string; table_name: string }>(`
      select c.conname as constraint_name, c.conrelid::regclass::text as table_name
      from pg_constraint c
      where c.contype = 'f'
        and c.connamespace = 'public'::regnamespace
        and not exists (
          select 1 from pg_index i
          where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]
        )
      order by 1
    `);
    expect(rows).toEqual([]);
  });
});
