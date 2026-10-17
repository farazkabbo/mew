-- Core schema for M0–M2: profiles, notebooks, pages, strokes, tutor_turns, mew_events.
--
-- Identity comes from Clerk through Supabase third-party auth. The user id is the JWT `sub`
-- claim (text, e.g. "user_2abc…"), read with `auth.jwt() ->> 'sub'`.
--
-- Security model:
--   * RLS on every table; each policy only matches rows whose user_id is the caller's `sub`.
--   * Privileges are granted explicitly per table and per column (the Supabase defaults are
--     revoked), so identifiers and ownership columns can't be rewritten, even by their owner.
--   * Child rows carry user_id plus a composite foreign key to (parent.id, parent.user_id), so a
--     user can never attach a row to someone else's notebook or page.
--   * jsonb and text columns have size limits so one user can't bloat the database.

create schema if not exists private;
revoke all on schema private from public;

create function private.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------------------------
create table public.profiles (
  id text primary key default (auth.jwt() ->> 'sub') check (id <> ''),
  name text check (char_length(name) <= 100),
  -- e.g. {"mew_threshold": 0.7, "voice_id": "…", "mew_logging_opt_in": false}
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint profiles_settings_object
    check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 16384),
  constraint profiles_settings_mew_threshold check (
    case
      when settings -> 'mew_threshold' is null then true
      when jsonb_typeof(settings -> 'mew_threshold') <> 'number' then false
      else (settings ->> 'mew_threshold')::numeric between 0 and 1
    end
  ),
  constraint profiles_settings_logging_opt_in check (
    settings -> 'mew_logging_opt_in' is null
    or jsonb_typeof(settings -> 'mew_logging_opt_in') = 'boolean'
  )
);

create trigger profiles_touch_updated_at before update on public.profiles
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- notebooks
-- ---------------------------------------------------------------------------------------------
create table public.notebooks (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default (auth.jwt() ->> 'sub')
    references public.profiles (id) on delete cascade,
  course_id uuid, -- foreign key to courses is added with the courses table (M7)
  title text not null default 'Untitled' check (char_length(title) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, user_id)
);

create index notebooks_user_id_idx on public.notebooks (user_id);
create trigger notebooks_touch_updated_at before update on public.notebooks
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- pages
-- ---------------------------------------------------------------------------------------------
create table public.pages (
  id uuid primary key default gen_random_uuid(),
  notebook_id uuid not null,
  user_id text not null default (auth.jwt() ->> 'sub'),
  index integer not null check (index >= 0),
  background text not null default 'dot_grid'
    check (background in ('dot_grid', 'blank', 'lined', 'grid')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, user_id),
  -- Deferrable so pages can be reordered inside one transaction.
  unique (notebook_id, index) deferrable initially deferred,
  foreign key (notebook_id, user_id)
    references public.notebooks (id, user_id) on delete cascade
);

create index pages_user_id_idx on public.pages (user_id);
create trigger pages_touch_updated_at before update on public.pages
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- strokes (vector ink; ids are generated client-side for local-first sync)
-- ---------------------------------------------------------------------------------------------
create table public.strokes (
  id uuid primary key,
  page_id uuid not null,
  user_id text not null default (auth.jwt() ->> 'sub'),
  author text not null check (author in ('student', 'tutor')),
  -- [[x, y, pressure, t], …]
  points jsonb not null
    check (jsonb_typeof(points) = 'array' and pg_column_size(points) <= 262144),
  -- [x, y, w, h]
  bbox real[] not null check (
    array_ndims(bbox) = 1 and cardinality(bbox) = 4 and array_position(bbox, null) is null
  ),
  color text not null check (color ~ '^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$'),
  width real not null check (width > 0 and width <= 100),
  group_id uuid,
  created_at timestamptz not null default now(),

  foreign key (page_id, user_id) references public.pages (id, user_id) on delete cascade
);

create index strokes_page_id_created_at_idx on public.strokes (page_id, created_at);
create index strokes_user_id_idx on public.strokes (user_id);

-- ---------------------------------------------------------------------------------------------
-- tutor_turns (append-only log of tutor responses)
-- ---------------------------------------------------------------------------------------------
create table public.tutor_turns (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null,
  user_id text not null default (auth.jwt() ->> 'sub'),
  mew_label text not null check (
    mew_label in ('answer_question', 'check_work', 'give_hint', 'complete_step', 'draw_visual')
  ),
  transcript text not null check (char_length(transcript) <= 8000),
  response jsonb not null
    check (jsonb_typeof(response) = 'object' and pg_column_size(response) <= 65536),
  latency_ms integer check (latency_ms >= 0),
  created_at timestamptz not null default now(),

  foreign key (page_id, user_id) references public.pages (id, user_id) on delete cascade
);

create index tutor_turns_page_id_created_at_idx on public.tutor_turns (page_id, created_at);
create index tutor_turns_user_id_idx on public.tutor_turns (user_id);

-- ---------------------------------------------------------------------------------------------
-- mew_events (gate inputs/outputs; only stored when the student has opted in)
-- ---------------------------------------------------------------------------------------------
create table public.mew_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default (auth.jwt() ->> 'sub')
    references public.profiles (id) on delete cascade,
  input jsonb not null
    check (jsonb_typeof(input) = 'object' and pg_column_size(input) <= 32768),
  output jsonb not null
    check (jsonb_typeof(output) = 'object' and pg_column_size(output) <= 4096),
  human_label text check (
    human_label in (
      'ignore', 'answer_question', 'check_work', 'give_hint', 'complete_step', 'draw_visual'
    )
  ),
  created_at timestamptz not null default now()
);

create index mew_events_user_id_created_at_idx on public.mew_events (user_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- Privileges: nothing for anon; explicit table/column grants for authenticated.
-- ---------------------------------------------------------------------------------------------
revoke all on public.profiles, public.notebooks, public.pages, public.strokes,
  public.tutor_turns, public.mew_events from anon, authenticated;

grant select, insert on public.profiles to authenticated;
grant update (name, settings) on public.profiles to authenticated;

grant select, insert, delete on public.notebooks to authenticated;
grant update (title, course_id) on public.notebooks to authenticated;

grant select, insert, delete on public.pages to authenticated;
grant update (index, background) on public.pages to authenticated;

grant select, insert, delete on public.strokes to authenticated;
grant update (points, bbox, color, width, group_id) on public.strokes to authenticated;

grant select, insert, delete on public.tutor_turns to authenticated;

grant select, insert, delete on public.mew_events to authenticated;
grant update (human_label) on public.mew_events to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.notebooks enable row level security;
alter table public.pages enable row level security;
alter table public.strokes enable row level security;
alter table public.tutor_turns enable row level security;
alter table public.mew_events enable row level security;

-- profiles: keyed by id rather than user_id.
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.jwt() ->> 'sub'));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = (select auth.jwt() ->> 'sub'));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.jwt() ->> 'sub'))
  with check (id = (select auth.jwt() ->> 'sub'));

-- notebooks, pages, strokes: full CRUD on own rows.
create policy notebooks_select on public.notebooks for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy notebooks_insert on public.notebooks for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy notebooks_update on public.notebooks for update to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy notebooks_delete on public.notebooks for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

create policy pages_select on public.pages for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy pages_insert on public.pages for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy pages_update on public.pages for update to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy pages_delete on public.pages for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

create policy strokes_select on public.strokes for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy strokes_insert on public.strokes for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy strokes_update on public.strokes for update to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy strokes_delete on public.strokes for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

-- tutor_turns: append-only (no update policy or grant).
create policy tutor_turns_select on public.tutor_turns for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy tutor_turns_insert on public.tutor_turns for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy tutor_turns_delete on public.tutor_turns for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

-- mew_events: inserts require the owner's explicit opt-in; only human_label is updatable.
create policy mew_events_select on public.mew_events for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy mew_events_insert on public.mew_events for insert to authenticated
  with check (
    user_id = (select auth.jwt() ->> 'sub')
    and exists (
      select 1 from public.profiles p
      where p.id = mew_events.user_id
        and p.settings -> 'mew_logging_opt_in' = 'true'::jsonb
    )
  );
create policy mew_events_update on public.mew_events for update to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy mew_events_delete on public.mew_events for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
