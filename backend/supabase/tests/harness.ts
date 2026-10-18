import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../migrations");

/**
 * The parts of a Supabase database that migrations rely on: API roles, `auth.jwt()` reading the
 * request claims, and Supabase's default grants on `public` (which the migrations must revoke).
 */
const SUPABASE_BOOTSTRAP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.jwt() to anon, authenticated, service_role;

  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

  -- Supabase installs extensions into their own schema.
  create schema extensions;
  grant usage on schema extensions to anon, authenticated, service_role;

  -- The slice of Supabase Storage the migrations use: buckets, objects (RLS on), foldername().
  create schema storage;
  grant usage on schema storage to anon, authenticated, service_role;
  create table storage.buckets (
    id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id),
    name text not null,
    owner_id text default (auth.jwt() ->> 'sub')
  );
  alter table storage.objects enable row level security;
  grant select, insert, delete on storage.objects to anon, authenticated;
  create function storage.foldername(name text) returns text[] language sql immutable as $$
    select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
  $$;
  grant execute on function storage.foldername(text) to anon, authenticated;
`;

export type Db = PGlite & {
  /** Run `fn` as an authenticated Clerk user (`sub` = userId), or as anon when userId is null. */
  as<T>(userId: string | null, fn: () => Promise<T>): Promise<T>;
};

export async function createTestDb(): Promise<Db> {
  const pg = new PGlite({ extensions: { vector } });
  await pg.exec(SUPABASE_BOOTSTRAP);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    await pg.exec(await readFile(path.join(MIGRATIONS_DIR, file), "utf8"));
  }

  const as = async <T>(userId: string | null, fn: () => Promise<T>): Promise<T> => {
    const claims = userId ? { sub: userId, role: "authenticated" } : { role: "anon" };
    await pg.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims)]);
    await pg.exec(`set role ${userId ? "authenticated" : "anon"}`);
    try {
      return await fn();
    } finally {
      await pg.exec("reset role");
      await pg.query("select set_config('request.jwt.claims', '', false)");
    }
  };

  return Object.assign(pg, { as });
}
