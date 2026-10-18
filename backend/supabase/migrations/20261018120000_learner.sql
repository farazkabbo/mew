-- Learner model (M8): every practice attempt with its evidence, and one FSRS review card per
-- concept.
--
-- Same security model as the other migrations: RLS on every table matching the caller's Clerk
-- `sub`, explicit per-column grants, size limits, and composite foreign keys that include
-- user_id, so a user can never attach a row to someone else's concept.

-- A concept belongs to exactly one course; attempts and cards name both, and this key lets the
-- database check that the pair (and its owner) is real.
alter table public.concepts
  add constraint concepts_id_course_user_key unique (id, course_id, user_id);

-- ---------------------------------------------------------------------------------------------
-- attempts (append-only): one answer to one practice or quiz question
-- ---------------------------------------------------------------------------------------------
create table public.attempts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default (auth.jwt() ->> 'sub'),
  course_id uuid not null,
  concept_id uuid not null,
  correct boolean not null,
  -- How the answer came about: on their own, after a hint, or after being shown how.
  evidence text not null check (evidence in ('independent', 'with_hint', 'after_explanation')),
  -- Where it happened: a lesson's practice questions, or a quiz in the notebook.
  source text not null check (source in ('practice', 'quiz')),
  created_at timestamptz not null default now(),

  unique (id, user_id),
  foreign key (concept_id, course_id, user_id)
    references public.concepts (id, course_id, user_id) on delete cascade
);

create index attempts_course_id_created_at_idx on public.attempts (course_id, created_at);
create index attempts_concept_id_idx on public.attempts (concept_id);

-- ---------------------------------------------------------------------------------------------
-- review_cards: the FSRS schedule of each concept the student has started
-- ---------------------------------------------------------------------------------------------
create table public.review_cards (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default (auth.jwt() ->> 'sub'),
  course_id uuid not null,
  concept_id uuid not null,
  -- ts-fsrs card: { due, stability, difficulty, reps, lapses, state, last_review, … }
  fsrs_state jsonb not null
    check (jsonb_typeof(fsrs_state) = 'object' and pg_column_size(fsrs_state) <= 2048),
  due_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, user_id),
  -- One card per concept. (Keyed with user_id so a duplicate can't reveal another user's card.)
  unique (concept_id, user_id),
  foreign key (concept_id, course_id, user_id)
    references public.concepts (id, course_id, user_id) on delete cascade
);

create index review_cards_user_id_due_at_idx on public.review_cards (user_id, due_at);
create index review_cards_course_id_idx on public.review_cards (course_id);
create trigger review_cards_touch_updated_at before update on public.review_cards
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Privileges: nothing by default; then exactly what the app needs. Attempts are a log: the
-- student adds and deletes them but never rewrites one, nor picks its id or timestamp.
-- ---------------------------------------------------------------------------------------------
revoke all on public.attempts, public.review_cards from anon, authenticated;

grant select, delete on public.attempts to authenticated;
grant insert (course_id, concept_id, correct, evidence, source) on public.attempts
  to authenticated;

grant select, delete on public.review_cards to authenticated;
grant insert (course_id, concept_id, fsrs_state, due_at) on public.review_cards to authenticated;
grant update (fsrs_state, due_at) on public.review_cards to authenticated;

alter table public.attempts enable row level security;
alter table public.review_cards enable row level security;

create policy attempts_select on public.attempts for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy attempts_insert on public.attempts for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy attempts_delete on public.attempts for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

create policy review_cards_select on public.review_cards for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy review_cards_insert on public.review_cards for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy review_cards_update on public.review_cards for update to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy review_cards_delete on public.review_cards for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
