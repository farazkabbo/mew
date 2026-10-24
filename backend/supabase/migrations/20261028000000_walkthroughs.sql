-- Walkthroughs (Screen Coach S4, docs/SCREEN_COACH.md §6 and decision 10): a task the student is
-- coached through on their screen, one step at a time.
--
-- Text only: the planned steps (instruction, success condition, two hints) and how each went
-- (hints given, checks, outcome). Never a screenshot, and never what the verifier saw. Rows are
-- written by the API service with the secret key, after it checked the desktop app's device
-- token (the desktop app has no Clerk session); every update is compare-and-set on `revision`.
-- Their owner can read and delete them (S7's history and data rights); nothing else. S5 adds the
-- skill each one builds. Deleting the account removes them with the profile.

create table public.walkthroughs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 60),
  -- What the student asked, in their words.
  goal text not null check (char_length(goal) between 1 and 200),
  app_exe_name text check (app_exe_name ~ '^[a-z0-9 ._+()-]{1,60}\.exe$'),
  status text not null default 'active'
    check (status in ('active', 'paused', 'stopped', 'completed')),
  phase text not null default 'awaiting' check (phase in ('awaiting', 'confirming')),
  -- The step being done, from 0.
  current_step integer not null default 0 check (current_step between 0 and 14),
  -- [{instruction, successCondition, hint, explicit, hints, checks, misses, outcome}, …]
  steps jsonb not null
    check (jsonb_typeof(steps) = 'array'
      and jsonb_array_length(steps) between 1 and 15
      and pg_column_size(steps) <= 65536),
  hints_used integer not null default 0 check (hints_used between 0 and 45),
  revision integer not null default 0 check (revision >= 0),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,

  check (case when jsonb_typeof(steps) = 'array'
    then current_step < jsonb_array_length(steps) else false end),
  check ((status = 'completed') = (completed_at is not null)),
  unique (id, user_id)
);

-- "Continue where we left off": the owner's latest unfinished walkthrough.
create index walkthroughs_user_id_updated_at_idx on public.walkthroughs (user_id, updated_at desc);

-- ---------------------------------------------------------------------------------------------
-- Privileges: owners read and delete; the API service writes.
-- ---------------------------------------------------------------------------------------------
revoke all on public.walkthroughs from anon, authenticated;

grant select, delete on public.walkthroughs to authenticated;

alter table public.walkthroughs enable row level security;

create policy walkthroughs_select on public.walkthroughs for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy walkthroughs_delete on public.walkthroughs for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
